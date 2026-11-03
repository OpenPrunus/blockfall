<?php

declare(strict_types=1);

namespace Blockfall\Engine;

/** Ce qu'un joueur peut faire d'un coup (par opposition aux touches tenues). */
enum Action: string
{
    case Cw = 'cw';
    case Ccw = 'ccw';
    case Hd = 'hd';
    case Hold = 'hold';
}
