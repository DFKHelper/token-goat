(* FORMAT-DERIVED: The F# Language Specification (F# 4.1), section 3.1 "Lexical Analysis"
   (comments, string/verbatim/triple-quoted string literals) and section 10 "Namespaces and
   Modules" / section 8 "Type Definitions" / section 12 "Exception Definitions" for
   `namespace`/`module`/`type`/`exception`. No live internet access was used to fetch the current
   published spec while writing this fixture -- these are the commonly-cited F# 4.1 section
   numbers, and the fixture follows those grammar productions, not this repo's extractor. *)

namespace Sample

/// Greets someone by name.
let greet name = "hello, " + name

type Shape =
  | Circle of float
  | Rectangle of float * float

exception BadShape of string

module Inner =
  let id x = x
