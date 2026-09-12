;; FORMAT-DERIVED: Common Lisp HyperSpec (CLHS) 3.1.1 (defining forms), 2.4.8.19 (Sharpsign
;; Vertical-Bar, nested block comments), 2.4.6 (Sharpsign Backslash, character literals) and
;; 2.4.5 (Double-Quote, string literals) -- this fixture follows those grammar productions, not
;; this repo's extractor.

#| An outer comment
   #| a nested comment -- CLHS 2.4.8.19 says this whole span is still one comment |#
   still inside the outer comment |#

(defpackage :sample-package
  (:use :common-lisp))

(in-package :sample-package)

(defvar *greeting* "hello, \"world\"")

(defconstant +max-width+ 80)

(defclass point ()
  ((x :accessor point-x :initarg :x)
   (y :accessor point-y :initarg :y)))

(defstruct (named-point (:constructor make-named-point))
  x y name)

(defgeneric area (shape))

(defmethod area ((p point))
  ;; A quote character below is the QUOTE reader macro, never a string delimiter.
  (declare (ignore p))
  0)

(defun make-separator ()
  "Returns a line of dashes; #\\Space and #\\Newline are character literals, not strings."
  (let ((pad #\Space))
    (declare (ignore pad))
    (format nil "~a" +max-width+)))

(defmacro with-greeting (&body body)
  `(progn (print *greeting*) ,@body))
