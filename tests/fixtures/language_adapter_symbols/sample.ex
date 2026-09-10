# HAND-DERIVED: standard Elixir syntax written from language knowledge, not from any adapter regex.
defmodule Inventory.Warehouse do
  defstruct items: []

  def add_item(%__MODULE__{items: items} = warehouse, name, quantity) do
    %{warehouse | items: [{name, quantity} | items]}
  end

  def total_quantity(%__MODULE__{items: items}) do
    Enum.reduce(items, 0, fn {_name, qty}, acc -> acc + qty end)
  end
end
