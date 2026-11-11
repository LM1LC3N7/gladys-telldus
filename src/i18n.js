// -----------------------------------------------------------------------------
// Runtime texts (English and French): device and feature names, the status
// of the integration, the answers of the buttons and the command refusals.
// None of them ever carries a key or a token of Telldus.
// -----------------------------------------------------------------------------

import { KIND } from './constants.js';

export const both = (en, fr) => ({ en, fr });

/** One language of a `{ en, fr }` text. */
export const word = (value, language) => (language === 'fr' ? value.fr : value.en);

/** "45 s", "5 min", "2 h". */
export function age(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 90) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}

/** Texts joined with ". ", in both languages. */
export function join(...parts) {
  const list = parts.filter(Boolean);
  return both(list.map((p) => p.en).join('. '), list.map((p) => p.fr).join('. '));
}

/** The model shown for a device, or the name of one of its features (`key`). */
export function kindLabel(kind, safe, language, key) {
  if (key === 'state') return word(both('State (assumed)', 'État (supposé)'), language);
  if (key === 'brightness')
    return word(both('Brightness (assumed)', 'Luminosité (supposée)'), language);
  const base =
    kind === KIND.DIMMER
      ? both('433 MHz dimmer', 'Variateur 433 MHz')
      : both('433 MHz on/off receiver', 'Récepteur marche/arrêt 433 MHz');
  const ro = both(' (read only: not declared safe)', ' (lecture seule : non déclaré sûr)');
  return word(base, language) + (safe ? '' : word(ro, language));
}

export function sensorLabel(key, language) {
  if (key === 'temperature') return word(both('Temperature', 'Température'), language);
  if (key === 'humidity') return word(both('Humidity', 'Humidité'), language);
  return word(both('Telldus sensor', 'Capteur Telldus'), language);
}

const CONFIG_KEYS = {
  public_key: both('public key', 'clé publique'),
  private_key: both('private key', 'clé privée'),
  token: both('token', 'jeton'),
  token_secret: both('token secret', 'secret du jeton'),
  host: both('address of the TellStick', 'adresse de la TellStick'),
  local_token: both('local token', 'jeton local'),
};

export const T = {
  connected: (devices, sensors, mode) =>
    both(
      `Connected to ${mode === 'live' ? 'Telldus Live' : 'the TellStick'}: ${devices} devices, ${sensors} sensors (433 MHz states are assumed, never confirmed)`,
      `Connecté à ${mode === 'live' ? 'Telldus Live' : 'la TellStick'} : ${devices} appareils, ${sensors} capteurs (les états 433 MHz sont supposés, jamais confirmés)`,
    ),
  configMissing: (keys) =>
    both(
      `Configuration incomplete or invalid: ${keys.map((k) => CONFIG_KEYS[k]?.en ?? k).join(', ')}`,
      `Configuration incomplète ou invalide : ${keys.map((k) => CONFIG_KEYS[k]?.fr ?? k).join(', ')}`,
    ),
  waitingToken: both(
    'No local token yet: click "Request local access", accept in the browser, then "Finish local access"',
    'Pas encore de jeton local : cliquez sur « Demander l’accès local », acceptez dans le navigateur, puis « Terminer l’accès local »',
  ),
  configNotRead: (wait) =>
    both(
      `The configuration could not be read from Gladys; next try in ${age(wait)}`,
      `La configuration n’a pas pu être lue dans Gladys ; nouvel essai dans ${age(wait)}`,
    ),
  refused: (mode) =>
    mode === 'live'
      ? both(
          'Telldus Live refused the keys: nothing is sent with them again; enter new keys or click "Test the connection"',
          'Telldus Live a refusé les clés : plus rien n’est envoyé avec elles ; saisissez de nouvelles clés ou cliquez sur « Tester la connexion »',
        )
      : both(
          'The TellStick refused the local token (expired or revoked): request a new local access',
          'La TellStick a refusé le jeton local (expiré ou retiré) : redemandez un accès local',
        ),
  paused: (wait) =>
    both(
      `Telldus asked to slow down or failed (429/5xx): reads paused for ${age(wait)}; turning off still leaves`,
      `Telldus a demandé de ralentir ou a échoué (429/5xx) : lectures en pause pendant ${age(wait)} ; éteindre part toujours`,
    ),
  unreachable: (kind) =>
    both(
      `Telldus not reachable (${kind}); next read at the next interval`,
      `Telldus injoignable (${kind}) ; nouvelle lecture à l’intervalle suivant`,
    ),
  badAnswer: both(
    'Telldus answered something unreadable; next read at the next interval',
    'Telldus a répondu quelque chose d’illisible ; nouvelle lecture à l’intervalle suivant',
  ),
  sensorsNotRead: (wait) =>
    both(
      `sensors not read (refused); next try in ${age(wait)}`,
      `capteurs non lus (refusé) ; nouvel essai dans ${age(wait)}`,
    ),
  storeUnreadable: both(
    '/data unreadable: reads wait for it (read again every 10 s); turning off still leaves',
    '/data illisible : les lectures l’attendent (relu toutes les 10 s) ; éteindre part toujours',
  ),
  stopLost: (names) =>
    both(
      `Turning off could not be sent: ${names.join(', ')}`,
      `L’extinction n’a pas pu être envoyée : ${names.join(', ')}`,
    ),
  safeInvalid: (n) =>
    both(
      `${n} invalid entries ignored in the safe list`,
      `${n} entrées invalides ignorées dans la liste sûre`,
    ),
  renewNotSaved: both(
    'The local token was renewed but Gladys did not save it: it is kept in memory and saved again at the next read',
    'Le jeton local a été renouvelé mais Gladys ne l’a pas enregistré : il est gardé en mémoire et réenregistré à la prochaine lecture',
  ),
  // Commands.
  sent: both(
    'sent (state assumed: 433 MHz gives no feedback)',
    'envoyé (état supposé : le 433 MHz ne répond pas)',
  ),
  sentNoAnswer: both(
    'sent, without confirmation (no answer from Telldus yet)',
    'envoyé, sans confirmation (pas encore de réponse de Telldus)',
  ),
  stopNotSent: both(
    'nothing sent yet: turning off is tried again',
    'rien envoyé pour l’instant : l’extinction est réessayée',
  ),
  stopRefusedAuth: both(
    'nothing sent: Telldus refused these credentials',
    'rien envoyé : Telldus a refusé ces identifiants',
  ),
  stopNoConfig: both(
    'nothing sent: the configuration is not read or not usable; turning off leaves as soon as it is',
    'rien envoyé : configuration non lue ou inutilisable ; l’extinction part dès qu’elle l’est',
  ),
  notSafe: both(
    'nothing sent: this device is not declared safe',
    'rien envoyé : cet appareil n’est pas déclaré sûr',
  ),
  notConfigured: both(
    'nothing sent: the configuration is not read or not usable',
    'rien envoyé : configuration non lue ou inutilisable',
  ),
  notKnown: both(
    'nothing sent: device not in the last list read from Telldus (read it again)',
    'rien envoyé : appareil absent de la dernière liste lue chez Telldus (relisez-la)',
  ),
  listOld: both(
    'nothing sent: the device list is too old (Telldus not read lately)',
    'rien envoyé : liste des appareils trop ancienne (Telldus non lu récemment)',
  ),
  otherMode: both(
    'nothing sent: device of the other connection mode',
    'rien envoyé : appareil de l’autre mode de connexion',
  ),
  notSupported: both(
    'nothing sent: the device does not take this command',
    'rien envoyé : l’appareil ne prend pas cette commande',
  ),
  invalidValue: both('nothing sent: invalid value', 'rien envoyé : valeur invalide'),
  pausedCommand: both(
    'nothing sent: Telldus asked to slow down (429/5xx), pause in progress',
    'rien envoyé : Telldus a demandé de ralentir (429/5xx), pause en cours',
  ),
  refusedCommand: both(
    'nothing sent: Telldus refused the credentials',
    'rien envoyé : Telldus a refusé les identifiants',
  ),
  storeCommand: both('nothing sent: /data not read yet', 'rien envoyé : /data pas encore lu'),
  supersededByStop: both(
    'nothing sent: a turn off came after it',
    'rien envoyé : une extinction est arrivée après',
  ),
  failedCommand: (kind) =>
    both(`not done: Telldus answered ${kind}`, `pas fait : Telldus a répondu ${kind}`),
  notSentCommand: (kind) => both(`nothing sent (${kind})`, `rien envoyé (${kind})`),
  // Buttons.
  testOk: (devices, sensors) =>
    both(
      `Connection works: ${devices.length} devices, ${sensors} sensors. Telldus ids: ${devices.map((d) => `${d.id} ${d.name} (${d.kind === KIND.DIMMER ? 'dimmer' : 'on/off'}${d.safe ? ', safe' : ''})`).join('; ') || 'none'}`,
      `La connexion fonctionne : ${devices.length} appareils, ${sensors} capteurs. Identifiants Telldus : ${devices.map((d) => `${d.id} ${d.name} (${d.kind === KIND.DIMMER ? 'variateur' : 'marche/arrêt'}${d.safe ? ', sûr' : ''})`).join(' ; ') || 'aucun'}`,
    ),
  testTooSoon: (wait) =>
    both(
      `Read less than a minute ago: the result of that read is shown; next read possible in ${age(wait)}`,
      `Lu il y a moins d’une minute : le résultat de cette lecture est affiché ; prochaine lecture possible dans ${age(wait)}`,
    ),
  reading: both('A read of Telldus is in progress', 'Une lecture de Telldus est en cours'),
  localOnly: both(
    'Only for the local mode (TellStick ZNet / Net v2)',
    'Seulement pour le mode local (TellStick ZNet / Net v2)',
  ),
  openThis: (url) =>
    both(
      `Open this address in a browser on your network, sign in and accept "Gladys Assistant", then click "Finish local access": ${url}`,
      `Ouvrez cette adresse dans un navigateur de votre réseau, connectez-vous et acceptez « Gladys Assistant », puis cliquez sur « Terminer l’accès local » : ${url}`,
    ),
  noRequest: both(
    'Click "Request local access" first',
    'Cliquez d’abord sur « Demander l’accès local »',
  ),
  notAccepted: both(
    'Not accepted yet in the browser: accept, then click again',
    'Pas encore accepté dans le navigateur : acceptez, puis cliquez de nouveau',
  ),
  tokenSaved: (expires) =>
    both(
      `Local access granted and saved in Gladys${expires ? ` (until ${expires})` : ''}`,
      `Accès local accordé et enregistré dans Gladys${expires ? ` (jusqu’au ${expires})` : ''}`,
    ),
  tokenNotSaved: both(
    'Access granted, but Gladys did not save the token: click again',
    'Accès accordé, mais Gladys n’a pas enregistré le jeton : cliquez de nouveau',
  ),
  actionFailed: (kind) => both(`Failed: ${kind}`, `Échec : ${kind}`),
};
