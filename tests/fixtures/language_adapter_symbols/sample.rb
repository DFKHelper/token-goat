# HAND-DERIVED: standard Ruby syntax written from language knowledge, not from any adapter regex.
module Inventory
  class Item
    attr_accessor :name, :quantity

    def initialize(name, quantity)
      @name = name
      @quantity = quantity
    end
  end

  def self.total(items)
    items.sum(&:quantity)
  end
end

class WarehouseError < StandardError
end
