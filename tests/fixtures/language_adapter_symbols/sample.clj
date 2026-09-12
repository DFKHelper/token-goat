;; FORMAT-DERIVED: clojure.org/reference/reader ("Comments" -- ; line comments only, no block
;; comment form; "Discard" -- #_ elides the next form; "Characters" -- bare \c / \newline / \space;
;; "Strings") and clojure.org/reference/special_forms plus core macros def/defn/defprotocol/
;; defrecord -- this fixture follows those grammar productions, not this repo's extractor.

(ns sample.core)

(defn greet
  "Returns a greeting string."
  [name]
  (str "hello " name))

;; #_ elides the entire next form -- this defn must never become a symbol.
#_(defn unused-fn [x] x)

(def max-width 80)

(defprotocol Shape
  (area [this]))

(defrecord Point [x y]
  Shape
  (area [_] 0))

(defmulti describe :kind)

(defmethod describe :circle [_] "a circle")

(def line-char \-)
(def newline-char \newline)
(def greeting-text "a \"quoted\" word")
