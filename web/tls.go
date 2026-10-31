package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/pem"
	"fmt"
	"log"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// certWatcher serves the certificate in RMS_TLS_DIR and picks up a
// replacement by itself: drop a real certificate over the self-signed
// one and new connections use it within a minute, no restart.
type certWatcher struct {
	certPath, keyPath string
	mu                sync.Mutex
	cert              *tls.Certificate
	mod               time.Time
	checked           time.Time
}

func newCertWatcher(c *config) *certWatcher {
	return &certWatcher{certPath: filepath.Join(c.TLSDir, c.TLSCertName), keyPath: filepath.Join(c.TLSDir, c.TLSKeyName)}
}

func (w *certWatcher) available() bool {
	_, err := w.get()
	return err == nil
}

func (w *certWatcher) get() (*tls.Certificate, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.cert != nil && time.Since(w.checked) < time.Minute {
		return w.cert, nil
	}
	w.checked = time.Now()
	ci, err1 := os.Stat(w.certPath)
	ki, err2 := os.Stat(w.keyPath)
	if err1 != nil || err2 != nil {
		if w.cert != nil {
			return w.cert, nil
		}
		return nil, fmt.Errorf("no certificate at %s / %s", w.certPath, w.keyPath)
	}
	mod := ci.ModTime()
	if ki.ModTime().After(mod) {
		mod = ki.ModTime()
	}
	if w.cert != nil && !mod.After(w.mod) {
		return w.cert, nil
	}
	c, err := tls.LoadX509KeyPair(w.certPath, w.keyPath)
	if err != nil {
		if w.cert != nil {
			log.Printf("TLS: new certificate in %s not usable (%v); keeping the current one", filepath.Dir(w.certPath), err)
			return w.cert, nil
		}
		return nil, err
	}
	if w.cert != nil {
		log.Printf("TLS: certificate reloaded from %s", w.certPath)
	}
	w.cert, w.mod = &c, mod
	return w.cert, nil
}

func (w *certWatcher) tlsConfig() *tls.Config {
	return &tls.Config{MinVersion: tls.VersionTLS12,
		GetCertificate: func(*tls.ClientHelloInfo) (*tls.Certificate, error) { return w.get() }}
}

// tlsInit runs once before the app (as root, with only the capabilities a
// chown needs): makes the certificate folder usable by the app user and puts
// a self-signed certificate there when none is installed. It never touches
// a certificate it finds.
func tlsInit() error {
	dir := env("RMS_TLS_DIR", "/certs")
	certPath := filepath.Join(dir, env("RMS_TLS_CERT_NAME", "tls.crt"))
	keyPath := filepath.Join(dir, env("RMS_TLS_KEY_NAME", "tls.key"))
	uid, _ := strconv.Atoi(env("RMS_APP_UID", "1000"))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	if _, err := os.Stat(certPath); err == nil {
		log.Printf("tls-init: %s exists, left as it is", certPath)
		return chownTree(dir, uid)
	}
	hosts := []string{"localhost", "127.0.0.1"}
	if u := env("RMS_PUBLIC_URL", ""); u != "" {
		if h := hostOf(u); h != "" {
			hosts = append(hosts, h)
		}
	}
	for _, h := range strings.Split(env("RMS_TLS_HOSTNAME", ""), ",") {
		if h = strings.TrimSpace(h); h != "" {
			hosts = append(hosts, h)
		}
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	tpl := &x509.Certificate{
		SerialNumber: new(big.Int).SetBytes(randomBytes(16)),
		Subject:      pkix.Name{CommonName: hosts[len(hosts)-1], Organization: []string{"RoadMap Studio (self-signed)"}},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().AddDate(2, 0, 0),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	for _, h := range hosts {
		if ip := net.ParseIP(h); ip != nil {
			tpl.IPAddresses = append(tpl.IPAddresses, ip)
		} else {
			tpl.DNSNames = append(tpl.DNSNames, h)
		}
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		return err
	}
	kb, _ := x509.MarshalECPrivateKey(key)
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kb}), 0o600); err != nil {
		return err
	}
	if err := os.WriteFile(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o644); err != nil {
		return err
	}
	log.Printf("tls-init: made a self-signed certificate for %s in %s - replace %s and %s with a real certificate when you have one",
		strings.Join(hosts, ", "), dir, filepath.Base(certPath), filepath.Base(keyPath))
	return chownTree(dir, uid)
}

// initCredentials makes the database password file the first time, owned by
// the app user and readable by nobody else. Postgres reads it as root.
func initCredentials() error {
	dir := env("RMS_CREDENTIALS_DIR", "/credentials")
	uid, _ := strconv.Atoi(env("RMS_APP_UID", "1000"))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	p := filepath.Join(dir, "db_password")
	if _, err := os.Stat(p); err == nil {
		log.Printf("init-credentials: %s exists, left as it is", p)
	} else {
		pw := base64.RawURLEncoding.EncodeToString(randomBytes(24))
		if err := os.WriteFile(p, []byte(pw), 0o400); err != nil {
			return err
		}
		log.Printf("init-credentials: made %s", p)
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return err
	}
	return chownTree(dir, uid)
}

func chownTree(dir string, uid int) error {
	if os.Geteuid() != 0 {
		return nil
	}
	return filepath.Walk(dir, func(p string, _ os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		return os.Lchown(p, uid, uid)
	})
}

func hostOf(u string) string {
	u = strings.TrimPrefix(strings.TrimPrefix(u, "https://"), "http://")
	u = strings.SplitN(u, "/", 2)[0]
	if h, _, err := net.SplitHostPort(u); err == nil {
		return h
	}
	return u
}
