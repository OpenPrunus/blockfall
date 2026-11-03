<?php

declare(strict_types=1);

namespace Blockfall\Game\Handler;

use Blockfall\Game\Client;
use Blockfall\Game\ClientStatus;
use Blockfall\Game\Event;
use Blockfall\Game\Lobby;
use Blockfall\Game\MatchQueue;
use Blockfall\Game\MatchService;

/** « Partie rapide » : on rejoint la file ; dès qu'un autre joueur attend, le match commence. */
final readonly class QueueHandler implements MessageHandler
{
    public function __construct(private Lobby $lobby, private MatchQueue $queue, private MatchService $matches)
    {
    }

    #[\Override]
    public function handle(Client $client, array $msg): void
    {
        if ($client->status !== ClientStatus::Lobby || $client->invite !== null) {
            $client->error('busy');

            return;
        }
        $client->status = ClientStatus::Queued;
        $opponent = $this->queue->pairOrWait($client);
        if ($opponent !== null) {
            $this->matches->start($opponent, $client);
        } else {
            $client->send(Event::Queued);
        }
        $this->lobby->dirty = true;
    }
}
