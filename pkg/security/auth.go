package security

import (
	"crypto/subtle"
	"net/http"
)

// AuthConfig stores authentication credentials
type AuthConfig struct {
	Enabled  bool
	Users    map[string]string // username -> password
	Password string            // simple single-password mode (any username or 'interstellar')
}

// CheckCredentials returns true if credentials are valid
func (a *AuthConfig) CheckCredentials(user, pass string) bool {
	if !a.Enabled {
		return true
	}

	if a.Password != "" {
		if subtle.ConstantTimeCompare([]byte(pass), []byte(a.Password)) == 1 {
			return true
		}
	}

	if len(a.Users) > 0 {
		expectedPass, ok := a.Users[user]
		if ok && subtle.ConstantTimeCompare([]byte(pass), []byte(expectedPass)) == 1 {
			return true
		}
	}

	return false
}

// Middleware creates an HTTP authentication middleware
func (a *AuthConfig) Middleware(next http.Handler) http.Handler {
	if !a.Enabled {
		return next
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, pass, ok := r.BasicAuth()
		if !ok || !a.CheckCredentials(user, pass) {
			w.Header().Set("WWW-Authenticate", `Basic realm="Interstellar Secure Proxy"`)
			http.Error(w, "Unauthorized. Authentication required to access this proxy.", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}
