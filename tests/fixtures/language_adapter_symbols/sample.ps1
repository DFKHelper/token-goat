# HAND-DERIVED: standard PowerShell syntax written from language knowledge, not from any adapter regex.
function Add-Quantity {
    param(
        [int]$A,
        [int]$B
    )
    return $A + $B
}

class Item {
    [string]$Name
    [int]$Quantity
}
