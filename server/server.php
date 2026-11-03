<?php

/**
 * Serveur multijoueur de Blockfall : WebSocket (RFC 6455) en PHP pur.
 *
 * - Salon : liste des joueurs connectés, défis par clic sur un pseudo, partie rapide (matchmaking).
 * - Match : un duel. Le serveur fait tourner les deux plateaux à 60 images par seconde (même moteur que le navigateur), reçoit
 *   les touches des joueurs et leur renvoie les changements d'état. Les lignes faites partent chez l'adversaire.
 *   Classement Elo pour les parties classées.
 *
 * Variables d'environnement : WS_PORT (8081), WS_ALLOWED_ORIGINS (liste séparée par des virgules, vide = tout),
 * BLOCKFALL_DATA_DIR (dossier du classement). Le code est dans src/ (namespace Blockfall\).
 */

declare(strict_types=1);

use Arcade\Network\TrustedProxies;
use Arcade\Server\SocketServer;
use Arcade\Support\Env;
use Arcade\Support\StdoutLogger;
use Arcade\Support\SystemClock;
use Arcade\WebSocket\Handshake;
use Blockfall\Game\GameHub;
use Blockfall\Game\HubConfig;
use Blockfall\Ranking\RankingStore;

set_time_limit(0);
require __DIR__ . '/bootstrap.php';

$port = (int) Env::string('WS_PORT', '8081');
$origins = array_values(array_filter(array_map('trim', explode(',', Env::string('WS_ALLOWED_ORIGINS')))));
$dataDir = rtrim(Env::string('BLOCKFALL_DATA_DIR', dirname(__DIR__) . '/web/data'), '/');
$store = new RankingStore($dataDir . '/ratings.json');

$hub = GameHub::create(HubConfig::fromEnvironment(), $store, new SystemClock(), new StdoutLogger());
try {
    $proxies = TrustedProxies::fromString(Env::string('TRUSTED_PROXIES'));
    $perIp = (int) Env::number('BLOCKFALL_MAX_CONN_PER_IP', 10, true);
    $server = SocketServer::listen($port, $hub, new Handshake($origins), 1 / 60, 300, $proxies, $perIp);
} catch (RuntimeException $e) {
    fwrite(STDERR, $e->getMessage() . "\n");
    exit(1);
}

fwrite(STDOUT, 'Ranking: ' . count($hub->ranking()->ranking) . " player(s) loaded from {$store->file()}"
    . (is_writable($dataDir) ? '' : ' (WARNING: directory not writable, results will not be saved)') . "\n");
fwrite(STDOUT, "Blockfall WS listening on :$port\n");            // dernier message de démarrage : le serveur est prêt

$server->run();
