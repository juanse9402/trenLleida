let castInitialized = false;

// Global callback called by the Google Cast SDK once it finishes loading
window.__onGCastApiAvailable = function(isAvailable) {
  if (isAvailable) {
    initializeCastApi();
  }
};

function initializeCastApi() {
  try {
    cast.framework.CastContext.getInstance().setOptions({
      receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
      autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED
    });
    castInitialized = true;
    console.log('Google Cast API initialized successfully.');
  } catch (err) {
    console.error('Failed to initialize Cast Context:', err);
  }
}

/**
 * Transmite un video por URL al Chromecast activo en bucle (loop)
 * @param {string} videoUrl - URL absoluta del video mp4
 * @param {string} title - Título que se mostrará en el Chromecast
 */
export function castVideo(videoUrl, title = 'Parada Actual') {
  if (!castInitialized) {
    console.warn('Cast API is not initialized yet.');
    return;
  }

  const castContext = cast.framework.CastContext.getInstance();
  const session = castContext.getCurrentSession();
  
  if (!session) {
    console.log('No active Cast session to stream media.');
    return;
  }

  console.log(`Sending media to Cast session: URL=${videoUrl}, Title=${title}`);
  
  const mediaInfo = new chrome.cast.media.MediaInfo(videoUrl, 'video/mp4');
  mediaInfo.metadata = new chrome.cast.media.GenericMediaMetadata();
  mediaInfo.metadata.title = title;

  const request = new chrome.cast.media.LoadRequest(mediaInfo);
  // Set repeat mode to loop the current video continuously
  request.repeatMode = chrome.cast.media.RepeatMode.SINGLE;

  session.loadMedia(request).then(
    () => console.log('Successfully loaded media on Chromecast.'),
    (errorCode) => console.error('Failed to load media on Chromecast. Code:', errorCode)
  );
}

/**
 * Retorna si hay una sesión activa de Cast
 * @returns {boolean}
 */
export function isCasting() {
  if (!castInitialized) return false;
  return !!cast.framework.CastContext.getInstance().getCurrentSession();
}
