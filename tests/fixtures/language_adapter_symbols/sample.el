;;; sample.el --- fixture for the Emacs Lisp adapter -*- lexical-binding: t; -*-
;; FORMAT-DERIVED: GNU Emacs Lisp Reference Manual, node "Comment Tips" (only `;` line comments,
;; no block comment form), node "Basic Char Syntax" / "General Escape Syntax" (?a, ?\C-a, ?\M-a
;; character literals) and node "String Type" -- this fixture follows those grammar productions,
;; not this repo's extractor.

(defgroup sample-group nil
  "A sample customization group.")

(defcustom sample-width 80
  "Sample width."
  :type 'integer
  :group 'sample-group)

(defvar sample-greeting "hello, \"world\"")

(defconst sample-max-lines 100)

(defun sample-greet (name)
  "Return a greeting for NAME."
  (concat sample-greeting " " name))

(defmacro sample-with-greeting (&rest body)
  "Run BODY after printing the greeting."
  `(progn (message sample-greeting) ,@body))

(defface sample-face
  '((t :weight bold))
  "A sample face.")

(define-derived-mode sample-mode fundamental-mode "Sample"
  "A sample major mode.")

(cl-defstruct sample-point x y)

(defun sample-control-char ()
  "?\\C-a is a control character literal, not the start of a string."
  ?\C-a)
