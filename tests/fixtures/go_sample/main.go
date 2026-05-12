package main

import (
	"fmt"
	"errors"
)

const Version = "0.1.0"

var defaultPort = 8080

type Server struct {
	Name string
	Port int
}

type Handler interface {
	Serve(w string) error
}

func main() {
	s := NewServer("api", 8080)
	s.Run()
}

func NewServer(name string, port int) *Server {
	return &Server{Name: name, Port: port}
}

func (s *Server) Run() error {
	return fmt.Errorf("not implemented")
}

var _ = errors.New("unused")
