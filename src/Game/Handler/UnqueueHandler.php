<?php

declare(strict_types=1);

namespace Blockfall\Game\Handler;

use Blockfall\Game\Client;
use Blockfall\Game\ClientStatus;
use Blockfall\Game\Event;
use Blockfall\Game\Lobby;
use Blockfall\Game\MatchQueue;

final readonly class UnqueueHandler implements MessageHandler
{
    public function __construct(private Lobby $lobby, private MatchQueue $queue)
    {
    }

    #[\Override]
    public function handle(Client $client, array $msg): void
    {
        $this->queue->leave($client);
        if ($client->status === ClientStatus::Queued) {
            $client->status = ClientStatus::Lobby;
            $client->send(Event::Unqueued);
            $this->lobby->dirty = true;
        }
    }
}
