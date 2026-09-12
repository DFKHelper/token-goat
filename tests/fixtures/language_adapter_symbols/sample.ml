(* FORMAT-DERIVED: The OCaml Manual, chapter 11 "The OCaml language", section 1
   "Lexical conventions" (https://v2.ocaml.org/manual/lex.html) -- "Comments"
   (https://v2.ocaml.org/manual/lex.html#sss:lex:comments), "String literals"
   (https://v2.ocaml.org/manual/lex.html#sss:stringliterals), "Character literals"
   (https://v2.ocaml.org/manual/lex.html#sss:character-literals) -- and section 8 "Type and
   exception definitions" and section 9 "Classes" of the same manual for `type`/`exception`/
   `class`. This fixture follows those grammar productions, not this repo's extractor. *)

(** Greets someone by name. *)
let greet name = "hello, " ^ name

type shape =
  | Circle of float
  | Rectangle of float * float

exception Bad_shape of string

class sizeable =
  object
    method size = 0.0
  end

module Sample = struct
  let id x = x
end
