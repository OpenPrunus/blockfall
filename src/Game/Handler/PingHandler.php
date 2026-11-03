<?php

declare(strict_types=1);

namespace Blockfall\Game\Handler;

use Blockfall\Game\Client;
use Blockfall\Game\Event;

final readonly class PingHandler implements MessageHandler
{
    #[\Override]
    public function handle(Client $client, array $msg): void
    {
        $client->send(Event::Pong, ['c' => is_int($msg['c'] ?? null) ? $msg['c'] : 0]);
    }
}
