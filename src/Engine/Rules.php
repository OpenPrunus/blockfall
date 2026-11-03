<?php

declare(strict_types=1);

namespace Blockfall\Engine;

/** Constantes du jeu : doivent rester identiques à `C` et `GRAVITY` dans web/js/engine.js (les vecteurs de test le vérifient). */
final class Rules
{
    final public const int COLS = 10;
    final public const int ROWS = 22;
    final public const int HIDDEN = 2;              // rangées cachées en haut
    final public const int DAS = 10;                // images avant la répétition automatique d'un déplacement
    final public const int ARR = 2;                 // images entre deux répétitions
    final public const int SOFT = 2;                // images par rangée en chute douce
    final public const int LOCK_DELAY = 30;         // images posée au sol avant de se figer
    final public const int MAX_RESETS = 15;         // remises à zéro du délai par pièce
    final public const int ARE = 8;                 // images entre deux pièces
    final public const int CLEAR_ARE = 20;          // idem après une ligne
    final public const int GARBAGE_CAP = 8;         // lignes reçues au plus à chaque pose
    final public const int QUEUE = 6;               // pièces à venir tenues en avance
    final public const int TIME_LEVEL = 1800;       // images par niveau en duel
    final public const int MAX_LEVEL = 20;
    final public const int TICKS_PER_SECOND = 60;
    final public const int GARBAGE = 8;             // valeur d'une case de ligne reçue

    /** Rangées par image × 65536, du niveau 1 au niveau 20. */
    final public const array GRAVITY = [
        0, 1092, 1377, 1768, 2311, 3075, 4169, 5759, 8107, 11634, 17026,
        25416, 38709, 60169, 95483, 154742, 256187, 433425, 749597, 1310720, 1310720,
    ];

    final public const array COMBO_BONUS = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 4, 5];
    final public const array LINE_POINTS = [0, 100, 300, 500, 800];
    final public const array ATTACK = [0, 0, 1, 2, 4];
}
