self.onmessage = function (event) {
  console.log("Received message:", event.data); // Логируем полученное сообщение
  const data = JSON.parse(event.data);

  if (data.turboMode !== undefined) {
    console.log("Turbo mode received:", data.turboMode); // Логируем получение режима Turbo
    isTurboMode = data.turboMode;
    return;
  }

  if (data.startNonce !== undefined && data.endNonce !== undefined) {
    console.log("Received new nonce range:", data.startNonce, data.endNonce); // Логируем новый диапазон nonce
    startNonce = data.startNonce;
    endNonce = data.endNonce;

    if (!isProcessing) {
      console.log("Starting nonce processing..."); // Логируем начало обработки
      isProcessing = true;
      processNonceRanges();
    } else {
      console.log("Queueing new nonce range..."); // Логируем добавление в очередь
      nonceRanges.push({ startNonce, endNonce });
    }
  } else {
    console.log("Received task data:", data); // Логируем получение данных задачи
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
  console.log("Processing nonce ranges..."); // Логируем начало процесса
  while (true) {
    if (taskDataUpdated) {
      console.log("Task data updated, clearing nonce ranges..."); // Логируем обновление данных задачи
      nonceRanges = [];
      startNonce = 0;
      endNonce = 0;
      taskDataUpdated = false;
      postMessage('requestRange');
      await new Promise((resolve) => {
        const handler = function (event) {
          const data = JSON.parse(event.data);
          console.log("Received range after task data update:", data); // Логируем новый диапазон
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

    console.log("Processing current nonce range:", startNonce, endNonce); // Логируем текущий диапазон
    let result = await processNonceRange(taskData, startNonce, endNonce);
    if (result) {
      console.log("Nonce processed successfully, sending result..."); // Логируем успешную обработку
      postMessage(JSON.stringify(result));
      break;
    } else {
      console.log("No result found, checking next range..."); // Логируем отсутствие результата
      if (nonceRanges.length > 0) {
        const nextRange = nonceRanges.shift();
        startNonce = nextRange.startNonce;
        endNonce = nextRange.endNonce;
      } else {
        postMessage('requestRange');
        await new Promise((resolve) => {
          const handler = function (event) {
            const data = JSON.parse(event.data);
            console.log("Received new range request:", data); // Логируем новый запрос диапазона
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
  if (isTurboMode) return;

  hashesProcessed++;
  const now = Date.now();

  if (now - lastMeasurement >= MEASURE_INTERVAL) {
    const currentHashRate = (hashesProcessed * 1000) / (now - lastMeasurement);
    if (!baselineHashRate) {
      baselineHashRate = currentHashRate;
    } else {
      const performanceRatio = currentHashRate / baselineHashRate;
      needsCooldown = performanceRatio < HASH_THRESHOLD;
    }

    hashesProcessed = 0;
    lastMeasurement = now;
    console.log("Thermal check: performance ratio:", (currentHashRate / baselineHashRate).toFixed(2)); // Логируем результаты термальной проверки
  }

  if (needsCooldown) {
    console.log("Cooldown needed..."); // Логируем необходимость в охлаждении
    await new Promise(resolve => setTimeout(resolve, COOLDOWN_TIME));
    needsCooldown = false;
  }
}

async function processNonceRange(task, startNonce, endNonce) {
  let nonce = startNonce;

  console.log("Processing nonce range from", startNonce, "to", endNonce); // Логируем диапазон nonce
  while (nonce < endNonce) {
    if (taskDataUpdated) {
      console.log("Task data updated, aborting nonce range process..."); // Логируем прерывание
      return null;
    }

    await checkThermal();

    const timestamp = Date.now();
    const input = `${task.index}-${task.previousHash}-${task.data}-${nonce}-${timestamp}-${task.minerId}`;
    const hash = await sha256(input);
    console.log("Hash calculated:", hash); // Логируем вычисленный хэш

    const validState = isValidBlock(hash, task.mainFactor, task.shareFactor);
    if (validState === 'valid') {
      console.log("Valid block found, sending result..."); // Логируем успешный блок
      return {
        state: 'valid',
        hash: hash,
        data: task.data,
        nonce: nonce,
        timestamp: timestamp,
        minerId: task.minerId,
      };
    } else if (validState === 'share') {
      console.log("Share block found, sending result..."); // Логируем блок share
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
  console.log("Validating hash:", hash); // Логируем процесс валидации хэша
  if (typeof hash !== 'string' || !/^[0-9a-fA-F]+$/.test(hash)) {
    console.error('Invalid hash value:', hash); // Логируем ошибку при неверном хэше
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
