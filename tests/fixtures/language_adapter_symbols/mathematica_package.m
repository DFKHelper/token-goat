(* FORMAT-DERIVED: https://reference.wolfram.com/language/ref/BeginPackage.html (a Wolfram Language package is a .m file opened with BeginPackage) *)
BeginPackage["Collatz`"]

Collatz::usage = "Collatz[n] gives a list of the iterates in the 3n+1 problem, starting from n."

Begin["`Private`"]

Collatz[1] := {1}
Collatz[n_Integer] := Prepend[Collatz[3 n + 1], n] /; OddQ[n] && n > 0
Collatz[n_Integer] := Prepend[Collatz[n/2], n] /; EvenQ[n] && n > 0

End[]

EndPackage[]
