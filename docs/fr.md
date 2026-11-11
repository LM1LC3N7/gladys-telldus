# Telldus (TellStick et Telldus Live)

Amène dans Gladys les appareils et capteurs 433 MHz de votre TellStick :
prises et récepteurs marche/arrêt (Nexa, Proove, Chacon…), variateurs, et
les capteurs de température et d’humidité que la TellStick entend. Par
**Telldus Live** (le cloud, avec vos propres clés d’API) ou par l’**API
locale** d’une TellStick ZNet ou Net v2. Intégration non officielle, sans lien
avec Telldus. Jamais testée avec un vrai appareil : dites-nous ce qui marche
et ce qui ne marche pas.

## Connexion

**Telldus Live** : connectez-vous sur <https://api.telldus.com/keys>,
générez un jeton privé et recopiez les quatre valeurs (clé publique, clé
privée, jeton, secret du jeton) dans la configuration. Chaque requête est
signée (OAuth 1) avec elles ; elles sont gardées par Gladys dans sa base,
jamais réaffichées, envoyées seulement à Telldus Live, jamais écrites dans
les journaux, le statut ou `/data`. Telldus Live est lu au plus toutes les
60 s.

**API locale** (TellStick ZNet / Net v2) : choisissez « API locale »,
saisissez l’adresse de la TellStick (une adresse de votre réseau : jamais
une adresse de diffusion, de multidiffusion, `0.0.0.0` ou de bouclage),
enregistrez, cliquez sur **Demander l’accès local**, ouvrez l’adresse
affichée dans un navigateur de votre réseau, acceptez « Gladys Assistant »,
puis cliquez sur **Terminer l’accès local** : le jeton est enregistré dans la
configuration de Gladys (jamais dans `/data`). Quand la TellStick le permet,
le jeton est renouvelé une semaine avant son expiration. L’API locale est en
HTTP simple : à utiliser sur un réseau de confiance seulement. Elle peut être
lue toutes les 10 s.

Les identifiants d’appareils diffèrent entre Telldus Live et l’API locale :
changer de mode donne de nouveaux appareils dans Gladys.

## Appareils et capteurs

La **Découverte** propose les appareils de la dernière liste lue (aucune
requête de plus) :

- un récepteur marche/arrêt : un **interrupteur** une fois déclaré sûr ;
- un variateur : une **lumière** (marche/arrêt et luminosité 0-100 %) une fois
  déclaré sûr ;
- un capteur : température (°C ; Fahrenheit converti) et humidité (%).

Groupes, sonnettes, volets, thermostats et autres valeurs des capteurs
(pluie, vent, UV, puissance) ne sont pas gérés dans cette version.

**Les récepteurs 433 MHz ne répondent rien.** L’état affiché est la dernière
commande envoyée par Telldus (depuis Gladys, l’appli Telldus, un programme,
ou une télécommande entendue par la TellStick) : un état **supposé**, jamais
confirmé. Une commande acceptée par Telldus est « envoyée », pas « faite ».

Une valeur de capteur est publiée quand elle est plus récente que la
dernière publiée (date source gardée dans `/data`) et date de moins de
2 heures par rapport à la date de la réponse de Telldus ; une valeur sans
date, dans le futur, vide ou textuelle n’est jamais publiée (jamais comme 0).

## Appareils déclarés sûrs

Une prise peut alimenter un radiateur, une pompe ou une porte de garage, et
un « tout éteindre/allumer » d’un assistant vocal ou d’une scène atteint
chaque interrupteur et chaque lumière. Un appareil est donc affiché en
**lecture seule** (type inconnu) tant que son identifiant Telldus n’est pas
listé dans **Appareils déclarés sûrs** (par exemple `1234567, 1234568`). Le
bouton **Tester la connexion** donne les identifiants. Ce sont ceux du mode de connexion actuel : Telldus Live et l’API locale
numérotent les appareils différemment. Après un changement
de la liste, scannez et mettez à jour l’appareil dans l’onglet Découverte.
Une fonction créée avant le changement de la liste est gardée ; allumer par
elle est alors refusé.

Allumer, ou une luminosité au-dessus de 0, est refusé (rien n’est envoyé)
quand : `/data` n’est pas encore lu ; la configuration n’est pas lue ou pas
utilisable ; l’appareil est de l’autre mode de connexion ; il n’est pas
déclaré sûr (revérifié juste avant l’envoi) ; Telldus a refusé les
identifiants ; une pause après un 429 est en cours ; l’appareil n’est pas
dans la dernière liste ou cette liste a plus de 15 minutes ; l’appareil ne
prend pas cette commande ; une extinction du même appareil est arrivée après
le clic. Sans réponse de Telldus sous 3 s, une commande partie est
« envoyée, sans confirmation ».

## Éteindre

Éteindre (ou une luminosité de 0) n’attend ni la liste sûre, ni une pause,
ni la liste des appareils, ni une lecture en cours (elle est coupée), ni
`/data`. L’extinction part tout de suite, est renvoyée après 3 s et 10 s (un
récepteur 433 MHz peut manquer une émission), et un envoi qui échoue est
réessayé toutes les 10 s, 6 essais et 2 minutes au plus (le statut nomme
ensuite l’appareil). Un allumage du même appareil accepté par Telldus, ou une
lecture partie au moins 3 s après le dernier envoi et montrant l’appareil
rallumé (appli Telldus ou télécommande), arrête les renvois ; un renvoi dû
pendant qu’un allumage plus récent est en route attend sa réponse. Un envoi
auquel Telldus répond une erreur (401/403, 4xx, `error`, 429) est « refusé
par Telldus » et réessayé dans 10 s ; un 429 met aussi les lectures en pause.
Les 2 minutes sont comptées sur une horloge monotone (un changement d’heure
du système ne fait jamais abandonner une extinction). Les extinctions en attente sont gardées dans `/data` et
continuent après un redémarrage (jamais au-delà de 2 minutes).

L’extinction ne part pas seulement quand : la configuration n’est pas encore
lue ou pas utilisable (elle est gardée et part dès qu’elle l’est, dans ses
2 minutes) ; l’appareil est de l’autre mode de connexion ; Telldus a refusé
ces identifiants-là.

## Erreurs et limites

- **401/403 sur la liste des appareils** : identifiants refusés. Plus rien
  n’est envoyé avec eux de lui-même (le refus et une marque de 32 bits, salée,
  sont gardés dans `/data`) ; de nouveaux identifiants, un nouvel accès local
  ou un succès du bouton **Tester la connexion** le lèvent. Un 401/403 sur les
  capteurs seuls, ou sur une commande, n’est pas un refus : les capteurs sont
  alors lus moins souvent (jusqu’à une fois par heure).
- **429 ou 5xx sur une lecture** : lectures en pause (1 minute, doublée à
  chaque fois de suite, jusqu’à 6 heures, plus si Telldus le demande par
  Retry-After), gardée dans `/data`. Un 5xx sur la commande d’un appareil ne
  bloque jamais les autres.
- Réponses bornées (512 Ko, 10 s). Le bouton **Tester la connexion** ne lit
  jamais moins de 60 s (Live) ou 10 s (local) après la dernière lecture ; un
  redémarrage ne lit jamais avant l’intervalle après la dernière lecture.
- `/data` illisible : les lectures l’attendent (relu toutes les 10 s), rien
  n’est écrasé ; éteindre part quand même.
