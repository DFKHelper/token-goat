require "json"
require_relative "../lib/utils"

module Animals
  KINGDOM = "Animalia"
  MAX_AGE = 100

  class Animal
    attr_reader :name, :age
    attr_accessor :status

    def initialize(name, age)
      @name = name
      @age = age
    end

    def speak
      puts "#{@name} says hello"
    end

    def self.create(name, age)
      new(name, age)
    end

    def to_s
      "#{@name} (#{@age})"
    end
  end

  class Dog < Animal
    def bark
      puts "woof"
    end

    def fetch(item)
      item
    end
  end

  Point = Struct.new(:x, :y)

  def standalone_helper(x)
    x * 2
  end
end
