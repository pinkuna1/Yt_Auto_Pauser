if (window.ytAutoPauseInjected !== true) {
  window.ytAutoPauseInjected = true;
  let manuallyPaused = false;
  let automaticallyPaused = false;

  let options = {
    autopause: true,
    autoresume: true,
    scrollpause: false,
    lockpause: true,
    lockresume: true,
    focuspause: false,
    focusresume: false,
    disabled: false,
    cursorTracking: false,
    manualPause: true,
    debugMode: false,
  };

  function debugLog(message) {
    if (options.debugMode) {
      console.log(`YouTube auto pause: ${message}`);
    }
  }

  // Initialize settings from storage
  refresh_settings();

  function refresh_settings() {
    chrome.storage.sync.get(Object.keys(options), function (result) {
      options = Object.assign(options, result);
      if (options.disabled === true) {
        options.autopause = false;
        options.autoresume = false;
        options.scrollpause = false;
        options.lockpause = false;
        options.lockresume = false;
        options.focuspause = false;
        options.focusresume = false;
        options.cursorTracking = false;
        options.debugMode = false;
        for (var host of hosts) {
          options[host] = false;
        }
      }
    });
  }

  chrome.storage.onChanged.addListener(async function (changes, namespace) {
    for (const key in changes) {
      debugLog(
        `Settings changed for key ${key} from ${changes[key].oldValue} to ${changes[key].newValue}`
      );
      options[key] = changes[key].newValue;
    }

    if (!options.manualPause) {
      manuallyPaused = false;
      automaticallyPaused = true;
    }

    if ("disabled" in changes) {
      refresh_settings();
    }
  });

  // Function to check if the cursor is near the edge of the window
  function isCursorNearEdge(event) {
    const threshold = 50; // pixels from the edge
    return (
      event.clientX < threshold ||
      event.clientX > window.innerWidth - threshold ||
      event.clientY < threshold ||
      event.clientY > window.innerHeight - threshold
    );
  }

  let cursorNearEdgeTimeout;

  // Listen for mousemove events
  window.addEventListener("mousemove", async function (event) {
    if (!options.cursorTracking) {
      return;
    }
    if (isCursorNearEdge(event)) {
      // If the cursor is near the edge, set a timeout
      if (!cursorNearEdgeTimeout) {
        cursorNearEdgeTimeout = setTimeout(function () {
          debugLog(`Cursor near window edge, sending message`);
          sendMessage({ cursorNearEdge: true });
          cursorNearEdgeTimeout = null;
        }, 200); // Wait for 1 second to infer user intention
      }
    } else {
      // If the cursor moves away from the edge, clear the timeout
      clearTimeout(cursorNearEdgeTimeout);
      cursorNearEdgeTimeout = null;
      debugLog(`Cursor not near window edge, sending message`);
      sendMessage({ cursorNearEdge: false });
    }
  });

  // Existing code...

  // Send message to service worker
  function sendMessage(message) {
    if (!chrome.runtime?.id) {
      return;
    }

    if (chrome.runtime.lastError) {
      console.error(
        `Youtube Autopause error: ${chrome.runtime.lastError.toString()}`
      );
      return;
    }

    debugLog(`Sending message ${JSON.stringify(message)}`);

    chrome.runtime.sendMessage(message, function () {
      void chrome.runtime.lastError;
    });
  }

  // Listen to visibilitychange event of the page
  document.addEventListener(
    "visibilitychange",
    function () {
      if (document.hidden !== undefined) {
        debugLog(`Document hidden, sending minimized ${document.hidden}`);
        sendMessage({ minimized: document.hidden });
      }
    },
    false
  );

  // Listen media commands from the service worker
  chrome.runtime.onMessage.addListener(async function (
    request,
    sender,
    sendResponse
  ) {
    if (!("action" in request)) {
      return false;
    }
    debugLog(`Received message: ${JSON.stringify(request)}`);

    const videoElements = document.getElementsByTagName("video");
    const iframeElements = document.getElementsByTagName("iframe");

    for (let i = 0; i < iframeElements.length; i++) {
      const iframe = iframeElements[i];
      try {
        if (request.action === "stop") {
          iframe.contentWindow.postMessage(
            JSON.stringify({ event: "command", func: "pauseVideo" }),
            "*"
          );
        } else if (request.action === "resume") {
          iframe.contentWindow.postMessage(
            JSON.stringify({ event: "command", func: "playVideo" }),
            "*"
          );
        }
      } catch (e) {
        debugLog(e);
      }
    }

    for (let i = 0; i < videoElements.length; i++) {
      try {
        if (request.action === "stop" && !manuallyPaused) {
          automaticallyPaused = true;
          videoElements[i].pause();
        } else if (
          request.action === "resume" &&
          videoElements[i].paused &&
          !manuallyPaused
        ) {
          automaticallyPaused = false;
          if (!videoElements[i].ended) {
            await videoElements[i].play();
          }
        } else if (request.action === "toggle_mute") {
          videoElements[i].muted = !videoElements[i].muted;
        } else if (request.action === "mute") {
          videoElements[i].muted = true;
        } else if (request.action === "unmute") {
          videoElements[i].muted = false;
        } else if (request.action === "toggle") {
          if (videoElements[i].paused && !manuallyPaused) {
            if (!videoElements[i].ended) {
              await videoElements[i].play();
            }
            automaticallyPaused = false;
          } else if (!manuallyPaused) {
            videoElements[i].pause();
            automaticallyPaused = true;
          }
        }
      } catch (e) {
        debugLog(e);
      }
    }
    sendResponse({});
    return true;
  });

  // Intersection observer for the video elements in page
  // can be used to determine when video goes out of viewport
  const intersection_observer = new IntersectionObserver(
    function (entries) {
      if (!options.scrollpause) {
        return;
      }
      if (entries[0].isIntersecting === true) {
        debugLog(`Video not anymore in viewport`);
        sendMessage({ visible: true });
      } else {
        debugLog(`Video in viewport`);
        sendMessage({ visible: false });
      }
    },
    { threshold: [0] }
  );

  // Start observing video elements
  let videoElements = document.getElementsByTagName("video");
  for (let i = 0; i < videoElements.length; i++) {
    intersection_observer.observe(videoElements[i]);
    videoElements[i].addEventListener("pause", async (_e) => {
      if (!automaticallyPaused && options.manualPause) {
        debugLog(`Manually paused video`);
        manuallyPaused = true;
        automaticallyPaused = false;
      }
    });
    videoElements[i].addEventListener("play", (_e) => {
      if (options.manualPause) {
        debugLog(`Manually resumed video`);
        manuallyPaused = false;
      }
    });
  }
}
