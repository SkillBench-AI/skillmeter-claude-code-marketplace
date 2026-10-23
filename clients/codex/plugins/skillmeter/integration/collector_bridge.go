// Synthetic local adapter: actual EventProcessor and PromptStore, with an
// API-Gateway-shaped request. AWS credentials and endpoint must be test-only.
package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"

	"github.com/aws/aws-lambda-go/events"
	"github.com/skillbench/skillmeter-lambda/handler"
	"github.com/skillbench/skillmeter-lambda/storage"
)

func main() {
	if !strings.HasPrefix(os.Getenv("AWS_ENDPOINT_URL_S3"), "http://127.0.0.1:") || os.Getenv("AWS_ACCESS_KEY_ID") != "testing" {
		panic("synthetic localhost S3 required")
	}
	store, err := storage.NewPromptStore(context.Background())
	if err != nil {
		panic(err)
	}
	processor := handler.NewAPIHandler(handler.NewEventProcessor(nil, store))
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		panic(err)
	}
	var mutex sync.Mutex
	dropped := false
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mutex.Lock()
		defer mutex.Unlock()
		body, err := io.ReadAll(io.LimitReader(r.Body, 6*1024*1024))
		if err != nil {
			http.Error(w, "read", 500)
			return
		}
		headers := map[string]string{}
		for key, values := range r.Header {
			headers[strings.ToLower(key)] = values[0]
		}
		req := events.APIGatewayV2HTTPRequest{Headers: headers, Body: base64.StdEncoding.EncodeToString(body), IsBase64Encoded: true}
		req.RequestContext.HTTP.Path = r.URL.Path
		req.RequestContext.HTTP.Method = r.Method
		response, err := processor.HandleRequest(r.Context(), req)
		if err != nil {
			http.Error(w, "internal fixture failure", 500)
			return
		}
		if response.StatusCode >= 300 {
			for key, value := range response.Headers {
				w.Header().Set(key, value)
			}
			w.WriteHeader(response.StatusCode)
			fmt.Fprint(w, response.Body)
			return
		}
		// Simulate response loss AFTER the real conditional S3 write committed.
		if !dropped {
			dropped = true
			conn, _, err := w.(http.Hijacker).Hijack()
			if err == nil {
				conn.Close()
			}
			return
		}
		w.WriteHeader(response.StatusCode)
		fmt.Fprint(w, response.Body)
	})}
	json.NewEncoder(os.Stdout).Encode(map[string]string{"url": "http://" + listener.Addr().String() + "/logs/codex"})
	if err := server.Serve(listener); err != nil {
		panic(err)
	}
}
