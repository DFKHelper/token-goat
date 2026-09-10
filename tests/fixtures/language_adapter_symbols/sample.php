<?php
// HAND-DERIVED: standard PHP syntax written from language knowledge, not from any adapter regex.

namespace Inventory;

class Item
{
    private string $name;

    public function __construct(string $name, int $quantity)
    {
        $this->name = $name;
    }

    public function getName(): string
    {
        return $this->name;
    }
}

function addQuantity(int $a, int $b): int
{
    return $a + $b;
}
