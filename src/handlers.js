// -----------------------------------------------------------------------------
// The SDK handlers, wired to the app. Shared by index.js and the tests, so the
// tests run the exact wiring of the container.
// -----------------------------------------------------------------------------

import { ACTIONS } from './constants.js';

export function registerHandlers(gladys, app, logger) {
  // Discovery: the devices and sensors of the last read (never a read sooner than the interval).
  gladys.onScanRequest(() => app.scan());
  gladys.onDeviceCreated((device) => app.deviceCreated(device));
  gladys.onDeviceUpdated((device) => app.deviceCreated(device));
  gladys.onDeviceDeleted((device) => app.deviceDeleted(device));

  // Commands: devices declared safe; turning off is never held.
  gladys.onSetValue(async (device, feature, value) => {
    const outcome = await app.setValue(device, feature, value);
    logger?.info(`Command to ${feature?.external_id}: ${outcome}`);
  });

  // Configuration screen buttons.
  gladys.onAction(ACTIONS.TEST, () => app.testConnection());
  gladys.onAction(ACTIONS.REQUEST_LOCAL, () => app.requestLocalAccess());
  gladys.onAction(ACTIONS.FINISH_LOCAL, () => app.finishLocalAccess());

  // Configuration saved by the user.
  gladys.onConfigUpdated((config) => {
    logger?.info('Configuration updated');
    return app.configUpdated(config);
  });

  // Connection lifecycle: status and Discovery sent again on every connection
  // (the core keeps them in memory only); the configuration read until it comes.
  gladys.on('connected', () =>
    app.connected().catch((err) => logger?.error(`Start failed: ${err.message}`)),
  );
}
