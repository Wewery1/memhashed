self.onmessage = function (event) {
  const data = JSON.parse(event.data);

  if (data.turboMode !== undefined) {
    // Handle turbo mode toggle
    isTurboMode = data.turboMode;
    console.log("Turbo mode is now", isTurboMode ? "ON" : "OFF");  // Добавлено для вывода
    return;
  }

  if (data.startNonce !== undefined && data.endNonce !== undefined) {
    // Received a new nonce range
    startNonce = data.startNonce;
    endNonce = data.endNonce;
    console.log(`Received nonce range: ${startNonce} - ${endNonce}`);  // Добавлено для вывода

    // Start processing if not already doing so
    if (!isProcessing) {
      isProcessing = true;
      console.log("Processing nonce ranges started");  // Добавлено для вывода
      processNonceRanges();
    } else {
      // New range received while processing; queue it
      nonceRanges.push({ startNonce, endNonce });
      console.log("Nonce range queued for later processing");  // Добавлено для вывода
    }
  } else {
    // Received initial task data or updated task data
    if (taskData !== null) {
      // Task data is being updated during processing
      // Set flag to indicate task data has been updated
      taskDataUpdated = true;
      console.log("Task data updated");  // Добавлено для вывода
      // Update taskData
      taskData = data;
    } else {
      // Initial task data
      taskData = data;
      console.log("Initial task data received");  // Добавлено для вывода
    }
  }
};

async function processNonceRanges() {
  while (true) {
    if (taskDataUpdated) {
      nonceRanges = [];
      startNonce = 0;
      endNonce = 0;
      taskDataUpdated = false;
      postMessage('requestRange');
      console.log("Requesting new nonce range");  // Добавлено для вывода
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
      console.log("Result sent: ", result);  // Добавлено для вывода
      break;
    } else {
      if (nonceRanges.length > 0) {
        const nextRange = nonceRanges.shift();
        startNonce = nextRange.startNonce;
        endNonce = nextRange.endNonce;
        console.log(`Next nonce range: ${startNonce} - ${endNonce}`);  // Добавлено для вывода
      } else {
        postMessage('requestRange');
        console.log("Requesting new nonce range");  // Добавлено для вывода
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
      console.log(`Current hash rate: ${currentHashRate}, performance ratio: ${performanceRatio}`);  // Добавлено для вывода
    }

    hashesProcessed = 0;
    lastMeasurement = now;
  }

  if (needsCooldown) {
    console.log("Cooling down...");  // Добавлено для вывода
    await new Promise(resolve => setTimeout(resolve, COOLDOWN_TIME));
    needsCooldown = false;
  }
}
