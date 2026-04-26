package main

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/modcompat/platform/apps/resolver/internal/app"
)

func main() {
	_ = app.NewService()

	http.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{
			"service": "resolver",
			"status":  "phase0-skeleton",
		})
	})

	log.Println("resolver listening on :8080")
	log.Fatal(http.ListenAndServe(":8080", nil))
}

