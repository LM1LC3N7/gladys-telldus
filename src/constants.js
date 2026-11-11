// -----------------------------------------------------------------------------
// Constants: manifest keys (frozen, users store them), Telldus API values,
// limits and timings. Every duration is in milliseconds.
// -----------------------------------------------------------------------------

/** Manifest action keys (frozen). */
export const ACTIONS = {
  TEST: 'test_connection',
  REQUEST_LOCAL: 'request_local_access',
  FINISH_LOCAL: 'finish_local_access',
};

/** Connection modes (config `mode`, frozen). */
export const MODES = { LIVE: 'live', LOCAL: 'local' };

/** Telldus Live API (official, OAuth 1 with the keys of the user). */
export const LIVE_API = 'https://api.telldus.com/json/';

/** The name the local API shows when the user grants access in the browser. */
export const APP_NAME = 'Gladys Assistant';

/** Telldus device methods (bit mask of the API). */
export const METHOD = {
  TURNON: 1,
  TURNOFF: 2,
  DIM: 16,
};
/** The methods asked with `supportedMethods` (the API filters `methods` and `state` with it). */
export const SUPPORTED_METHODS = METHOD.TURNON | METHOD.TURNOFF | METHOD.DIM;

/** Device kinds (frozen: they fix the feature keys). */
export const KIND = { ONOFF: 'onoff', DIMMER: 'dimmer' };

/** Sensor values read (Telldus `data[].name`) and their scales. */
export const SENSOR = { TEMPERATURE: 'temp', HUMIDITY: 'humidity' };
export const SCALE = { CELSIUS: 0, FAHRENHEIT: 1, PERCENT: 0 };

export const LIMITS = {
  /** Bytes of one API answer read at most (a larger one is cut and refused). */
  answerBytes: 512 * 1024,
  /** Devices and sensors kept from one list. */
  devices: 300,
  sensors: 300,
  /** Entries of the safe list. */
  safe: 300,
  /** Characters of a name kept. */
  name: 60,
  /** Gladys: states per minute. */
  statesPerMinute: 300,
  /** Source dates kept in /data (dedup of sensor values). */
  seen: 600,
  /** Stops kept in /data. */
  stops: 100,
  /** Characters of a status or action message. */
  message: 900,
};

export const TIMINGS = {
  /** Poll interval: default and bounds, per mode. */
  pollDefault: 60_000,
  pollMinLive: 60_000,
  pollMinLocal: 10_000,
  pollMax: 3_600_000,
  /** One read (devices or sensors) bounded in time. */
  readTimeout: 10_000,
  /** A command: the answer awaited at most this long before the ack (Gladys cuts at 5 s). */
  commandAck: 3_000,
  /** A command request itself, bounded (its answer may come after the ack). */
  commandTimeout: 8_000,
  /** A stop retried within this budget when nothing could be sent. */
  stopRetry: 250,
  /** A stop sent again after these delays from the click (433 MHz has no feedback). */
  stopResends: [3_000, 10_000],
  /** A read showing the device on cancels the resends only when it left this long after a send. */
  stopReadAfter: 3_000,
  /** A stop that could not be sent: tried again on this spacing, up to stopAttempts. */
  stopAttempts: 6,
  stopRetrySpacing: 10_000,
  /** A stop kept in /data is dropped past this age (never replayed late). */
  stopMaxAge: 120_000,
  /** 429 / 5xx: pause, doubled at each one in a row. */
  pauseMin: 60_000,
  pauseMax: 6 * 3_600_000,
  /** Secondary route refused (sensors): spacing, doubled up to this. */
  secondaryMax: 3_600_000,
  /** getConfig failed: spacing of the next tries. */
  configRetry: [5_000, 15_000, 60_000, 300_000],
  /** /data unreadable: read again on this timer. */
  storeRetry: 10_000,
  /** /data load or save bounded. */
  storeTimeout: 2_000,
  storeQueue: 2_000,
  /** States: flush spacing, freshness of a value waiting, measurement spacing. */
  flush: 1_000,
  stateFresh: 120_000,
  measurementSpacing: 5_000,
  stateHeartbeat: 3_600_000,
  /** A sensor value older than this is not published. */
  valueMaxAge: 2 * 3_600_000,
  /** Device list older than this: commands that start something are refused. */
  listMaxAge: 15 * 60_000,
  /** Local token renewed when it expires within this. */
  tokenRenewBefore: 7 * 24 * 3_600_000,
  /** Test button: never reads sooner than this after the last read. */
  testSpacing: 60_000,
};

/** Gladys core values (server/utils/constants.js). */
export const STATE = { OFF: 0, ON: 1 };
