self.onmessage = function (event) {
  console.log("Received message:", event.data); // Логируем входящее сообщение
  const data = JSON.parse(event.data);

  if (data.turboMode !== undefined) {
    console.log("Turbo mode toggled:", data.turboMode); // Логируем состояние turboMode
    isTurboMode = data.turboMode;
    return;
  }

  if (data.startNonce !== undefined && data.endNonce !== undefined) {
    console.log("Received nonce range:", data.startNonce, data.endNonce); // Логируем полученные диапазоны
    startNonce = data.startNonce;
    endNonce = data.endNonce;

    if (!isProcessing) {
      console.log("Starting to process nonce ranges...");
      isProcessing = true;
      processNonceRanges();
    } else {
      console.log("Queuing new nonce range");
      nonceRanges.push({ startNonce, endNonce });
    }
  } else {
    console.log("Received task data:", data); // Логируем данные задачи
    if (taskData !== null) {
      taskDataUpdated = true;
      taskData = data;
    } else {
      taskData = data;
    }
  }
};

let taskData = null;
let isProcessing = false;
let nonceRanges = [];
let startNonce = 0;
let endNonce = 0;
let taskDataUpdated = false;

let hashesProcessed = 0;
let lastMeasurement = Date.now();
let baselineHashRate = null;
let needsCooldown = false;
let isTurboMode = false;
const MEASURE_INTERVAL = 2000;
const COOLDOWN_TIME = 1000;
const HASH_THRESHOLD = 0.7;

async function processNonceRanges() {
  console.log("Processing nonce ranges...");
  while (true) {
    if (taskDataUpdated) {
      console.log("Task data updated, resetting ranges...");
      nonceRanges = [];
      startNonce = 0;
      endNonce = 0;
      taskDataUpdated = false;
      postMessage('requestRange');
      await new Promise((resolve) => {
        const handler = function (event) {
          const data = JSON.parse(event.data);
          console.log("Received new nonce range:", data); // Логируем получение нового диапазона
          if (data.startNonce !== undefined && data.endNonce !== undefined) {
            startNonce = data.startNonce;
            endNonce = data.endNonce;
            self.removeEventListener('message', handler);
            resolve();
          }
        };
        self.addEventListener('message', handler);
      });
      continue;
    }

    let result = await processNonceRange(taskData, startNonce, endNonce);
    console.log("Nonce range processed, result:", result); // Логируем результат обработки
    if (result) {
      postMessage(JSON.stringify(result));
      break;
    } else {
      if (nonceRanges.length > 0) {
        const nextRange = nonceRanges.shift();
        startNonce = nextRange.startNonce;
        endNonce = nextRange.endNonce;
      } else {
        postMessage('requestRange');
        await new Promise((resolve) => {
          const handler = function (event) {
            const data = JSON.parse(event.data);
            if (data.startNonce !== undefined && data.endNonce !== undefined) {
              startNonce = data.startNonce;
              endNonce = data.endNonce;
              self.removeEventListener('message', handler);
              resolve();
            }
          };
          self.addEventListener('message', handler);
        });
      }
    }
  }
}

async function checkThermal() {
  console.log("Checking thermal status..."); // Логируем начало проверки теплового состояния
  if (isTurboMode) return;

  hashesProcessed++;
  const now = Date.now();

  if (now - lastMeasurement >= MEASURE_INTERVAL) {
    const currentHashRate = (hashesProcessed * 1000) / (now - lastMeasurement);
    console.log("Current hash rate:", currentHashRate); // Логируем текущую скорость хэширования

    if (!baselineHashRate) {
      baselineHashRate = currentHashRate;
    } else {
      const performanceRatio = currentHashRate / baselineHashRate;
      console.log("Performance ratio:", performanceRatio); // Логируем соотношение производительности
      needsCooldown = performanceRatio < HASH_THRESHOLD;
    }

    hashesProcessed = 0;
    lastMeasurement = now;
  }

  if (needsCooldown) {
    console.log("Cooling down..."); // Логируем начало охлаждения
    await new Promise(resolve => setTimeout(resolve, COOLDOWN_TIME));
    needsCooldown = false;
  }
}

async function processNonceRange(task, startNonce, endNonce) {
  console.log("Processing nonce range from", startNonce, "to", endNonce); // Логируем обрабатываемый диапазон
  let nonce = startNonce;

  while (nonce < endNonce) {
    if (taskDataUpdated) {
      console.log("Task data updated during processing, stopping...");
      return null;
    }

    await checkThermal();

    const timestamp = Date.now();
    const input = `${task.index}-${task.previousHash}-${task.data}-${nonce}-${timestamp}-${task.minerId}`;
    const hash = await sha256(input);

    const validState = isValidBlock(hash, task.mainFactor, task.shareFactor);
    console.log("Hash processed:", hash, "State:", validState); // Логируем результат хэширования и состояние

    if (validState === 'valid') {
      return {
        state: 'valid',
        hash: hash,
        data: task.data,
        nonce: nonce,
        timestamp: timestamp,
        minerId: task.minerId,
      };
    } else if (validState === 'share') {
      postMessage(
        JSON.stringify({
          state: 'share',
          hash: hash,
          data: task.data,
          nonce: nonce,
          timestamp: timestamp,
          minerId: task.minerId,
        })
      );
    }

    nonce += 1;
  }

  return null;
}

async function calculateHash(index, previousHash, data, nonce, timestamp, minerId) {
  const input = `${index}-${previousHash}-${data}-${nonce}-${timestamp}-${minerId}`;
  return await sha256(input);
}

function isValidBlock(hash, mainFactor, shareFactor) {
  console.log("Validating hash:", hash); // Логируем хэш перед проверкой
  if (typeof hash !== 'string' || !/^[0-9a-fA-F]+$/.test(hash)) {
    console.error('Invalid hash value:', hash);
    return 'notValid';
  }

  const value = BigInt('0x' + hash);
  const mainFactorBigInt = BigInt(mainFactor);
  const shareFactorBigInt = BigInt(shareFactor);

  if (value < mainFactorBigInt) {
    return 'valid';
  } else if (value < shareFactorBigInt) {
    return 'share';
  } else {
    return 'notValid';
  }
}
