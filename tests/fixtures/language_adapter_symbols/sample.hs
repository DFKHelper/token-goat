-- FORMAT-DERIVED: Haskell 2010 Language Report (https://www.haskell.org/onlinereport/haskell2010/)
-- section 5.1 (module), 4.2.1 (data), 4.3.1 (class), and 4.3.2 (instance declarations) -- this
-- fixture follows those grammar productions, not this repo's extractor.
module Sample (greet, Shape (..)) where

-- | Greets someone by name.
greet :: String -> String
greet name = "hello, " ++ name

data Shape
  = Circle Double
  | Rectangle Double Double
  deriving (Show, Eq)

class Sizeable a where
  size :: a -> Double

instance Sizeable Shape where
  size (Circle r) = r
  size (Rectangle w h) = w * h
