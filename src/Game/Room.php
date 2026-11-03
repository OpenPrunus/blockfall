<?php

declare(strict_types=1);

namespace Blockfall\Game;

use Blockfall\Engine\Action;
use Blockfall\Engine\Input;
use Blockfall\Engine\Side;
use Blockfall\Engine\Versus;

/** Un match entre deux clients : le duel (moteur), les touches tenues et actions en attente, la phase, le résultat et la revanche. */
final class Room
{
    public RoomPhase $phase = RoomPhase::Countdown;
    /** Images restantes avant le départ. */
    public int $countdownFrames;
    /** @var array<int, int> touches tenues de chaque joueur (bit 0 gauche, 1 droite, 2 bas) */
    public array $held = [0, 0];
    /** @var array<int, int> touches pressées puis relâchées entre deux images : elles comptent une fois */
    public array $pulse = [0, 0];
    /** @var array<int, list<Action>> actions pressées depuis la dernière image, par plateau */
    public array $queued = [[], []];
    /** @var array<int, array<string, mixed>> dernier état envoyé de chaque plateau */
    public array $sent = [[], []];
    /** Le résultat a été communiqué aux joueurs. */
    public bool $finished = false;
    /** Fin de la fenêtre de revanche (horodatage), une fois le résultat connu. */
    public int $closeAt = 0;
    /** @var array{bool, bool} */
    public array $rematch = [false, false];
    public readonly Versus $duel;

    /** @param array{Client, Client} $players joueur du plateau 0, joueur du plateau 1 */
    public function __construct(public readonly array $players, public readonly bool $ranked, int $seed, int $countdownFrames)
    {
        $this->duel = new Versus($seed);
        $this->countdownFrames = $countdownFrames;
    }

    public function sideOf(Client $client): ?Side
    {
        return match ($client) {
            $this->players[0] => Side::Left,
            $this->players[1] => Side::Right,
            default => null,
        };
    }

    public function opponentOf(Side $side): Client
    {
        return $this->players[$side->opposite()->value];
    }

    /** L'entrée de ce plateau pour la prochaine image : touches tenues et actions en attente (qui sont consommées). */
    public function takeInput(int $i): Input
    {
        $input = Input::fromBits($this->held[$i] | $this->pulse[$i]);
        $this->pulse[$i] = 0;
        $actions = $this->queued[$i];
        $this->queued[$i] = [];

        return new Input($input->left, $input->right, $input->down, $actions);
    }
}
