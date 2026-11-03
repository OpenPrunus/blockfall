<?php

declare(strict_types=1);

namespace Blockfall\Game;

/** Où en est le match : compte à rebours, partie en cours, ou terminé (résultat annoncé, revanche possible). */
enum RoomPhase
{
    case Countdown;
    case Playing;
    case Over;
}
