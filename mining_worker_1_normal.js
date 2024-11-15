self.onmessage = function (event) {
  const data = JSON.parse(event.data);

  if (data.turboMode !== undefined) {
    // Handle turbo mode toggle
    isTurboMode = data.turboMode;
    return;
  }

  if (data.startNonce !== undefined && data.endNonce !== undefined) {
    // Received a new nonce range
    startNonce = data.startNonce;
    endNonce = data.endNonce;

    // Start processing if not already doing so
    if (!isProcessing) {
      isProcessing = true;
      processNonceRanges();
    } else {
      // New range received while processing; queue it
      nonceRanges.push({ startNonce, endNonce });
    }
  } else {
    // Received initial task data or updated task data
    if (taskData !== null) {
      // Task data is being updated during processing
      // Set flag to indicate task data has been updated
      taskDataUpdated = true;
      // Update taskData
      taskData = data;
    } else {
      // Initial task data
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

// Thermal management state
let hashesProcessed = 0;
let lastMeasurement = Date.now();
let baselineHashRate = null;
let needsCooldown = false;
let isTurboMode = false;
const MEASURE_INTERVAL = 2000; // Check every 2 seconds
const COOLDOWN_TIME = 1000;    // 1 second cooldown when needed
const HASH_THRESHOLD = 0.7;    // Throttle at 70% performance drop

async function processNonceRanges() {
  while (true) {
    if (taskDataUpdated) {
      nonceRanges = [];
      startNonce = 0;
      endNonce = 0;
      taskDataUpdated = false;
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
      continue;
    }

    let result = await processNonceRange(taskData, startNonce, endNonce);
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
  if (isTurboMode) return; // Skip thermal management in turbo mode

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
  }

  if (needsCooldown) {
    await new Promise(resolve => setTimeout(resolve, COOLDOWN_TIME));
    needsCooldown = false;
  }
}

async function processNonceRange(task, startNonce, endNonce) {
  let nonce = startNonce;

  while (nonce < endNonce) {
    if (taskDataUpdated) {
      return null;
    }

    await checkThermal();

    const timestamp = Date.now();
    const hash = await calculateHash(
      task.index,
      task.previousHash,
      task.data,
      nonce,
      timestamp,
      task.minerId
    );

    const validState = isValidBlock(hash, task.mainFactor, task.shareFactor);
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
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(input);

  const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

  return hashHex;
}

function isValidBlock(hash, mainFactor, shareFactor) {
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
