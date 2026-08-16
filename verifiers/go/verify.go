// Independent Conarium receipt + countersign verifier.
// Stdlib only. Exit codes match bin/conarium-verify.mjs and
// bin/conarium-countersign-verify.mjs. test-vectors/ is the reference.
package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

const (
	receiptV1 = "conarium-receipt/0.1"
	receiptV2 = "conarium-receipt/0.2"
	receiptV3 = "conarium-receipt/0.3"
	receiptV4 = "conarium-receipt/0.4"
	genesis   = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
)

var metaV3 = map[string]bool{"protocol": true, "operator-declared": true, "undeclared": true}

type options struct {
	target          string
	pubkeys         []string
	countersign     bool
	inclusion       string
	expectSeqFrom   *int
	expectCount     *int
	expectLastHash  string
	strict          bool
	jsonOut         bool
}

func main() {
	opts, err := parseArgs(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		fmt.Fprintln(os.Stderr, "Usage: verify <file|dir> --pubkey <path> [--pubkey <path2> ...] [--expect-seq-from N] [--expect-count N] [--expect-last-hash sha256:…] [--strict] [--json]")
		fmt.Fprintln(os.Stderr, "       verify --countersign <record.json> --pubkey <path> [--inclusion <proof.json>]")
		os.Exit(20)
	}
	if opts.countersign {
		os.Exit(runCountersign(opts))
	}
	os.Exit(runReceipts(opts))
}

func parseArgs(argv []string) (options, error) {
	var o options
	for i := 0; i < len(argv); i++ {
		a := argv[i]
		need := func() (string, error) {
			if i+1 >= len(argv) {
				return "", fmt.Errorf("%s requires a value", a)
			}
			i++
			return argv[i], nil
		}
		switch a {
		case "--pubkey":
			p, err := need()
			if err != nil {
				return o, err
			}
			o.pubkeys = append(o.pubkeys, p)
		case "--countersign":
			o.countersign = true
		case "--inclusion":
			p, err := need()
			if err != nil {
				return o, err
			}
			o.inclusion = p
		case "--expect-seq-from":
			p, err := need()
			if err != nil {
				return o, err
			}
			n, err := strconv.Atoi(p)
			if err != nil {
				return o, fmt.Errorf("--expect-seq-from requires an integer")
			}
			o.expectSeqFrom = &n
		case "--expect-count":
			p, err := need()
			if err != nil {
				return o, err
			}
			n, err := strconv.Atoi(p)
			if err != nil {
				return o, fmt.Errorf("--expect-count requires an integer")
			}
			o.expectCount = &n
		case "--expect-last-hash":
			p, err := need()
			if err != nil {
				return o, err
			}
			if !hashOK(p) {
				return o, fmt.Errorf("--expect-last-hash requires sha256:<64 hex chars>")
			}
			o.expectLastHash = strings.ToLower(p)
		case "--strict":
			o.strict = true
		case "--json":
			o.jsonOut = true
		case "--help", "-h":
			return o, fmt.Errorf("help")
		default:
			if strings.HasPrefix(a, "-") {
				return o, fmt.Errorf("unknown flag: %s", a)
			}
			if o.target != "" {
				return o, fmt.Errorf("unexpected argument: %s", a)
			}
			o.target = a
		}
	}
	if o.target == "" {
		return o, fmt.Errorf("missing <file|dir>")
	}
	return o, nil
}

func hashOK(s string) bool {
	if !strings.HasPrefix(strings.ToLower(s), "sha256:") {
		return false
	}
	h := s[7:]
	if len(h) != 64 {
		return false
	}
	for _, c := range h {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return true
}

func fail(code int, msg string, jsonOut bool, extra map[string]any) int {
	fmt.Fprintln(os.Stderr, msg)
	if jsonOut {
		payload := map[string]any{"ok": false, "code": code, "message": msg}
		for k, v := range extra {
			payload[k] = v
		}
		b, _ := json.Marshal(payload)
		fmt.Println(string(b))
	}
	return code
}

func canonicalize(v any) (string, error) {
	switch x := v.(type) {
	case nil:
		return "null", nil
	case bool:
		if x {
			return "true", nil
		}
		return "false", nil
	case json.Number:
		return canonNumber(x)
	case float64:
		b, err := json.Marshal(x)
		if err != nil {
			return "", err
		}
		return string(b), nil
	case string:
		return canonString(x), nil
	case []any:
		parts := make([]string, len(x))
		for i, item := range x {
			s, err := canonicalize(item)
			if err != nil {
				return "", err
			}
			parts[i] = s
		}
		return "[" + strings.Join(parts, ",") + "]", nil
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		parts := make([]string, 0, len(keys))
		for _, k := range keys {
			s, err := canonicalize(x[k])
			if err != nil {
				return "", err
			}
			parts = append(parts, canonString(k)+":"+s)
		}
		return "{" + strings.Join(parts, ",") + "}", nil
	default:
		return "", fmt.Errorf("canonicalize: unsupported type %T", v)
	}
}

func canonNumber(n json.Number) (string, error) {
	if i, err := n.Int64(); err == nil && !strings.ContainsAny(string(n), ".eE") {
		return strconv.FormatInt(i, 10), nil
	}
	f, err := n.Float64()
	if err != nil {
		return "", fmt.Errorf("canonicalize: non-finite number")
	}
	b, err := json.Marshal(f)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

func canonString(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 0x20 {
				fmt.Fprintf(&b, `\u%04x`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}

func receiptHash(r map[string]any) (string, error) {
	body := cloneMap(r)
	delete(body, "hash")
	delete(body, "sig")
	delete(body, "anchor")
	if ch, ok := body["chain"].(map[string]any); ok {
		c := cloneMap(ch)
		delete(c, "hash")
		body["chain"] = c
	}
	canon, err := canonicalize(body)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(canon))
	return fmt.Sprintf("sha256:%x", sum), nil
}

func cloneMap(m map[string]any) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

func decodeJSON(raw []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	return v, nil
}

func decodeCanonicalBase64(s string) ([]byte, error) {
	if s == "" || len(s)%4 != 0 {
		return nil, fmt.Errorf("not canonical base64")
	}
	for _, c := range s {
		ok := (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '+' || c == '/' || c == '='
		if !ok {
			return nil, fmt.Errorf("not canonical base64")
		}
	}
	buf, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return nil, err
	}
	if base64.StdEncoding.EncodeToString(buf) != s {
		return nil, fmt.Errorf("not canonical base64")
	}
	return buf, nil
}

func loadPubkeys(paths []string) (map[string]ed25519.PublicKey, int, string) {
	if len(paths) == 0 {
		return nil, 13, "no --pubkey given (refusing to skip signature checks)"
	}
	out := map[string]ed25519.PublicKey{}
	for _, path := range paths {
		pemBytes, err := os.ReadFile(path)
		if err != nil {
			return nil, 13, fmt.Sprintf("cannot read public key %s: %v", path, err)
		}
		block, _ := pem.Decode(pemBytes)
		if block == nil {
			return nil, 13, fmt.Sprintf("invalid public PEM %s", path)
		}
		pub, err := x509.ParsePKIXPublicKey(block.Bytes)
		if err != nil {
			return nil, 13, fmt.Sprintf("invalid public PEM %s: %v", path, err)
		}
		ed, ok := pub.(ed25519.PublicKey)
		if !ok {
			return nil, 13, fmt.Sprintf("expected Ed25519 at %s", path)
		}
		sidecar := path + ".keyid"
		idb, err := os.ReadFile(sidecar)
		if err != nil {
			return nil, 13, fmt.Sprintf("missing keyId sidecar: %s", sidecar)
		}
		keyID := strings.TrimSpace(string(idb))
		if keyID == "" {
			return nil, 13, fmt.Sprintf("empty keyId sidecar: %s", sidecar)
		}
		out[keyID] = ed
	}
	return out, 0, ""
}

func loadReceipts(target string) ([]map[string]any, int, string) {
	st, err := os.Stat(target)
	if err != nil {
		return nil, 20, fmt.Sprintf("path not found: %s", target)
	}
	var files []string
	if st.IsDir() {
		_ = filepath.WalkDir(target, func(p string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return err
			}
			switch strings.ToLower(filepath.Ext(p)) {
			case ".json", ".jsonl", ".receipt":
				files = append(files, p)
			}
			return nil
		})
		sort.Strings(files)
	} else {
		files = []string{target}
	}
	var receipts []map[string]any
	for _, file := range files {
		raw, err := os.ReadFile(file)
		if err != nil {
			return nil, 20, err.Error()
		}
		text := strings.TrimSpace(string(raw))
		if text == "" {
			continue
		}
		var lines []string
		if strings.Contains(text, "\n") && !strings.HasPrefix(strings.TrimLeft(text, " \t"), "[") {
			for _, line := range strings.Split(string(raw), "\n") {
				line = strings.TrimRight(line, "\r")
				if strings.TrimSpace(line) == "" {
					continue
				}
				lines = append(lines, line)
			}
		} else {
			lines = []string{text}
		}
		for i, line := range lines {
			v, err := decodeJSON([]byte(line))
			if err != nil {
				return nil, 20, fmt.Sprintf("invalid JSON in %s:%d: %v", file, i+1, err)
			}
			if arr, ok := v.([]any); ok {
				for _, item := range arr {
					m, ok := item.(map[string]any)
					if !ok {
						return nil, 20, fmt.Sprintf("schema invalid at %s: not an object", file)
					}
					receipts = append(receipts, m)
				}
				continue
			}
			m, ok := v.(map[string]any)
			if !ok {
				return nil, 20, fmt.Sprintf("schema invalid at %s: not an object", file)
			}
			receipts = append(receipts, m)
		}
	}
	return receipts, 0, ""
}

func asString(v any) (string, bool) {
	s, ok := v.(string)
	return s, ok
}

func asMap(v any) (map[string]any, bool) {
	m, ok := v.(map[string]any)
	return m, ok
}

func asInt(v any) (int, bool) {
	switch n := v.(type) {
	case json.Number:
		i, err := n.Int64()
		return int(i), err == nil
	case float64:
		return int(n), n == float64(int(n))
	case int:
		return n, true
	default:
		return 0, false
	}
}

func schemaOk(r map[string]any) string {
	if r == nil {
		return "not an object"
	}
	v, _ := asString(r["v"])
	if v != receiptV1 && v != receiptV2 && v != receiptV3 && v != receiptV4 {
		return fmt.Sprintf("unsupported version %v", r["v"])
	}
	if id, ok := asString(r["id"]); !ok || id == "" {
		return "missing id"
	}
	if _, ok := asString(r["ts"]); !ok {
		return "missing ts"
	}
	chain, ok := asMap(r["chain"])
	if !ok {
		return "missing chain"
	}
	if _, ok := asInt(chain["seq"]); !ok {
		return "chain.seq not integer"
	}
	if _, ok := asString(chain["prevHash"]); !ok {
		return "missing chain.prevHash"
	}
	if _, ok := asString(chain["hash"]); !ok {
		return "missing chain.hash"
	}
	if _, has := r["consentRef"]; !has {
		return "missing consentRef (must be null)"
	}
	if r["consentRef"] != nil {
		return "consentRef must be null"
	}
	if _, has := r["anchor"]; !has {
		return "missing anchor field"
	}
	for _, alan := range []string{"period", "request", "dataRefs", "policy", "flags", "masking", "outcome"} {
		if _, has := r[alan]; !has || r[alan] == nil {
			return "missing " + alan
		}
	}
	if _, ok := r["dataRefs"].([]any); !ok {
		return "dataRefs must be an array"
	}
	if _, ok := r["flags"].([]any); !ok {
		return "flags must be an array"
	}
	pol, ok := asMap(r["policy"])
	if !ok {
		return "policy.decision is required"
	}
	if _, ok := asString(pol["decision"]); !ok {
		return "policy.decision is required"
	}
	actor, ok := asMap(r["actor"])
	if !ok {
		return "missing actor"
	}
	atype, _ := asString(actor["type"])
	if v == receiptV1 {
		if atype != "service" {
			return "actor.type must be \"service\" in v0.1"
		}
	} else {
		if atype != "service" && atype != "user" {
			return "actor.type must be \"service\" or \"user\" in v0.2"
		}
		if a, ok := asString(actor["assurance"]); !ok || a == "" {
			return "actor.assurance is required in v0.2"
		}
		if atype == "user" {
			if a, _ := asString(actor["assurance"]); a == "shared-token" {
				return "actor.type \"user\" cannot carry assurance \"shared-token\""
			}
		}
	}
	if v == receiptV3 || v == receiptV4 {
		for _, alan := range []string{"model", "client"} {
			m, ok := asMap(r[alan])
			if !ok {
				return "missing " + alan
			}
			src, _ := asString(m["source"])
			if !metaV3[src] {
				if v == receiptV4 {
					return alan + ".source must be one of protocol|operator-declared|undeclared in v0.4"
				}
				return alan + ".source must be one of protocol|operator-declared|undeclared in v0.3"
			}
			if src == "undeclared" {
				if alan == "model" {
					if m["provider"] != nil || m["name"] != nil || m["version"] != nil {
						return alan + ".source is \"undeclared\" but carries values"
					}
				} else if m["name"] != nil || m["version"] != nil {
					return alan + ".source is \"undeclared\" but carries values"
				}
			}
		}
	}
	if v == receiptV4 {
		d, ok := asMap(r["disclosure"])
		if !ok {
			return "missing disclosure"
		}
		ds, _ := asString(d["source"])
		if ds != "measured" && ds != "undeclared" {
			return "disclosure.source must be measured|undeclared in v0.4"
		}
		if ds == "undeclared" {
			if d["hash"] != nil || d["bytes"] != nil {
				return "disclosure.source is \"undeclared\" but carries values"
			}
		} else {
			h, ok := asString(d["hash"])
			if !ok || !hashOK(h) {
				return "disclosure.hash must be sha256:<64 hex> when measured"
			}
			if _, ok := asInt(d["bytes"]); !ok {
				return "disclosure.bytes must be a non-negative integer when measured"
			}
			if n, _ := asInt(d["bytes"]); n < 0 {
				return "disclosure.bytes must be a non-negative integer when measured"
			}
		}
		dest, ok := asMap(r["destination"])
		if !ok {
			return "missing destination"
		}
		ss, _ := asString(dest["source"])
		if ss != "operator-declared" && ss != "undeclared" {
			return "destination.source must be operator-declared|undeclared in v0.4"
		}
		if ss == "undeclared" {
			if dest["value"] != nil {
				return "destination.source is \"undeclared\" but carries a value"
			}
		} else if val, ok := asString(dest["value"]); !ok || val == "" {
			return "destination.value is required when operator-declared"
		}
	}
	return ""
}

func verifySig(keys map[string]ed25519.PublicKey, receipt map[string]any) string {
	sig, ok := asMap(receipt["sig"])
	if !ok {
		return "missing sig"
	}
	if alg, _ := asString(sig["alg"]); alg != "Ed25519" {
		return fmt.Sprintf("unsupported sig.alg %v", sig["alg"])
	}
	keyID, _ := asString(sig["keyId"])
	pk, ok := keys[keyID]
	if !ok {
		return fmt.Sprintf("unknown keyId %s", keyID)
	}
	val, _ := asString(sig["value"])
	sigBuf, err := decodeCanonicalBase64(val)
	if err != nil {
		return "signature is not canonical base64"
	}
	chain, _ := asMap(receipt["chain"])
	hash, _ := asString(chain["hash"])
	if !ed25519.Verify(pk, []byte(hash), sigBuf) {
		return "signature cryptographically invalid"
	}
	return ""
}

func runReceipts(opts options) int {
	if opts.strict && opts.expectSeqFrom == nil {
		one := 1
		opts.expectSeqFrom = &one
	}
	tailPinned := opts.expectCount != nil || opts.expectLastHash != ""
	if opts.strict && !tailPinned {
		return fail(11, "strict mode requires a tail pin: --expect-count, --expect-last-hash, or --anchor-check", opts.jsonOut, nil)
	}
	keys, code, msg := loadPubkeys(opts.pubkeys)
	if code != 0 {
		return fail(code, msg, opts.jsonOut, nil)
	}
	receipts, code, msg := loadReceipts(opts.target)
	if code != 0 {
		return fail(code, msg, opts.jsonOut, nil)
	}
	if len(receipts) == 0 {
		if opts.expectCount != nil {
			return fail(11, fmt.Sprintf("count mismatch: expected %d receipt(s), found 0", *opts.expectCount), opts.jsonOut, nil)
		}
		if opts.expectLastHash != "" {
			return fail(11, fmt.Sprintf("last-hash mismatch: expected %s, found (empty chain)", opts.expectLastHash), opts.jsonOut, nil)
		}
		fmt.Fprintln(os.Stderr, "warning: empty chain (0 receipts) — this is not a verification that nothing was deleted. A hash chain cannot see a tail that is no longer in the file. Pass --expect-count or --expect-last-hash to pin length.")
		if opts.jsonOut {
			fmt.Println(`{"ok":true,"code":0,"warning":"empty","count":0}`)
		}
		return 0
	}
	if len(receipts) == 1 {
		fmt.Fprintln(os.Stderr, "warning: single-receipt chain")
	}
	prevHash := genesis
	var prevSeq *int
	if opts.expectSeqFrom != nil {
		n := *opts.expectSeqFrom - 1
		prevSeq = &n
	}
	for i, receipt := range receipts {
		where := fmt.Sprintf("%s#%d", opts.target, i)
		if err := schemaOk(receipt); err != "" {
			return fail(20, fmt.Sprintf("schema invalid at %s: %s", where, err), opts.jsonOut, map[string]any{"index": i})
		}
		expected, err := receiptHash(receipt)
		if err != nil {
			return fail(20, fmt.Sprintf("schema invalid at %s: %v", where, err), opts.jsonOut, map[string]any{"index": i})
		}
		chain, _ := asMap(receipt["chain"])
		stored, _ := asString(chain["hash"])
		if stored != expected {
			return fail(10, fmt.Sprintf("hash mismatch at %s: recomputed %s, stored %s", where, expected, stored), opts.jsonOut, map[string]any{"index": i})
		}
		gotPrev, _ := asString(chain["prevHash"])
		if gotPrev != prevHash {
			return fail(11, fmt.Sprintf("prevHash break at %s: expected %s, got %s", where, prevHash, gotPrev), opts.jsonOut, map[string]any{"index": i})
		}
		seq, _ := asInt(chain["seq"])
		if prevSeq != nil && seq != *prevSeq+1 {
			return fail(12, fmt.Sprintf("seq gap at %s: expected %d, got %d", where, *prevSeq+1, seq), opts.jsonOut, map[string]any{"index": i})
		}
		if i > 0 {
			prev, _ := asMap(receipts[i-1]["chain"])
			pseq, _ := asInt(prev["seq"])
			if seq <= pseq {
				return fail(12, fmt.Sprintf("seq non-increasing at %s: %d → %d", where, pseq, seq), opts.jsonOut, map[string]any{"index": i})
			}
			if seq != pseq+1 {
				return fail(12, fmt.Sprintf("seq gap at %s: expected %d, got %d", where, pseq+1, seq), opts.jsonOut, map[string]any{"index": i})
			}
		}
		if opts.expectSeqFrom != nil && i == 0 && seq != *opts.expectSeqFrom {
			return fail(12, fmt.Sprintf("seq start mismatch at %s: expected %d, got %d", where, *opts.expectSeqFrom, seq), opts.jsonOut, map[string]any{"index": i})
		}
		if err := verifySig(keys, receipt); err != "" {
			return fail(13, fmt.Sprintf("signature invalid at %s: %s", where, err), opts.jsonOut, map[string]any{"index": i})
		}
		prevHash = stored
		prevSeq = &seq
	}
	if opts.expectCount != nil && len(receipts) != *opts.expectCount {
		return fail(11, fmt.Sprintf("count mismatch: expected %d receipt(s), found %d", *opts.expectCount, len(receipts)), opts.jsonOut, nil)
	}
	if opts.expectLastHash != "" {
		last, _ := asMap(receipts[len(receipts)-1]["chain"])
		h, _ := asString(last["hash"])
		if strings.ToLower(h) != opts.expectLastHash {
			return fail(11, fmt.Sprintf("last-hash mismatch: expected %s, got %s", opts.expectLastHash, h), opts.jsonOut, nil)
		}
	}
	if !tailPinned {
		fmt.Fprintln(os.Stderr, "note: tail truncation is not visible — this run did not see receipts deleted from the end of the file. Pin with --expect-count, --expect-last-hash, or --anchor-check.")
	}
	if opts.jsonOut {
		fmt.Printf(`{"ok":true,"code":0,"count":%d}`+"\n", len(receipts))
	} else {
		fmt.Printf("ok: %d receipt(s) verified\n", len(receipts))
	}
	return 0
}

func countersignDigest(record map[string]any) (string, error) {
	copy := cloneMap(record)
	delete(copy, "sig")
	canon, err := canonicalize(copy)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(canon))
	return fmt.Sprintf("sha256:%x", sum), nil
}

func verifyInclusion(record map[string]any, proof map[string]any) bool {
	if proof == nil {
		return false
	}
	if fmt.Sprint(proof["seq"]) != fmt.Sprint(record["seq"]) || proof["hash"] != record["hash"] || proof["prevHash"] != record["prevHash"] {
		return false
	}
	path, ok := proof["path"].([]any)
	if !ok || len(path) == 0 {
		return false
	}
	first, ok := path[0].(map[string]any)
	if !ok || first["hash"] != record["hash"] || fmt.Sprint(first["seq"]) != fmt.Sprint(record["seq"]) {
		return false
	}
	prev := record["prevHash"]
	for _, step := range path {
		m, ok := step.(map[string]any)
		if !ok || m["prevHash"] != prev {
			return false
		}
		prev = m["hash"]
	}
	last, _ := path[len(path)-1].(map[string]any)
	head, _ := proof["head"].(map[string]any)
	return last != nil && head != nil && last["hash"] == head["hash"] && fmt.Sprint(last["seq"]) == fmt.Sprint(head["seq"])
}

func runCountersign(opts options) int {
	raw, err := os.ReadFile(opts.target)
	if err != nil {
		return fail(20, fmt.Sprintf("path not found: %s", opts.target), false, nil)
	}
	text := strings.TrimSpace(string(raw))
	v, err := decodeJSON([]byte(text))
	if err != nil {
		first := strings.Split(text, "\n")[0]
		v, err = decodeJSON([]byte(first))
		if err != nil {
			return fail(20, fmt.Sprintf("invalid JSON: %v", err), false, nil)
		}
	}
	rec, ok := v.(map[string]any)
	if !ok {
		return fail(20, "record must be an object", false, nil)
	}
	typ, _ := asString(rec["type"])
	if typ != "submit" && typ != "upgrade" {
		return fail(20, "schema: type must be submit or upgrade", false, nil)
	}
	if id, ok := asString(rec["id"]); !ok || id == "" {
		return fail(20, "schema: missing id", false, nil)
	}
	dig, ok := asString(rec["digest"])
	if !ok || !hashOK(dig) {
		return fail(20, "schema: digest must be sha256:<64 hex>", false, nil)
	}
	h, ok := asString(rec["hash"])
	if !ok || len(h) != 64 {
		return fail(20, "schema: hash must be 64 hex chars (entry hash)", false, nil)
	}
	seq, ok := asInt(rec["seq"])
	if !ok || seq < 1 {
		return fail(20, "schema: seq must be an integer >= 1", false, nil)
	}
	if _, ok := asString(rec["prevHash"]); !ok {
		return fail(20, "schema: missing prevHash", false, nil)
	}
	sig, ok := asMap(rec["sig"])
	if !ok {
		return fail(20, "schema: sig must be { alg: Ed25519, keyId, value }", false, nil)
	}
	if alg, _ := asString(sig["alg"]); alg != "Ed25519" {
		return fail(20, "schema: sig must be { alg: Ed25519, keyId, value }", false, nil)
	}
	if _, ok := asString(sig["keyId"]); !ok {
		return fail(20, "schema: sig must be { alg: Ed25519, keyId, value }", false, nil)
	}
	if _, ok := asString(sig["value"]); !ok {
		return fail(20, "schema: sig must be { alg: Ed25519, keyId, value }", false, nil)
	}
	keys, code, msg := loadPubkeys(opts.pubkeys)
	if code != 0 {
		return fail(code, msg, false, nil)
	}
	keyID, _ := asString(sig["keyId"])
	pk, ok := keys[keyID]
	if !ok {
		return fail(13, fmt.Sprintf("signature keyId %s is not in the provided pubkey set", keyID), false, nil)
	}
	digest, err := countersignDigest(rec)
	if err != nil {
		return fail(20, err.Error(), false, nil)
	}
	sigBuf, err := decodeCanonicalBase64(sig["value"].(string))
	if err != nil {
		return fail(13, "signature invalid", false, nil)
	}
	if !ed25519.Verify(pk, []byte(digest), sigBuf) {
		return fail(13, "signature invalid", false, nil)
	}
	if opts.inclusion != "" {
		incRaw, err := os.ReadFile(opts.inclusion)
		if err != nil {
			return fail(20, fmt.Sprintf("inclusion file not found: %s", opts.inclusion), false, nil)
		}
		iv, err := decodeJSON(incRaw)
		if err != nil {
			return fail(20, fmt.Sprintf("invalid inclusion JSON: %v", err), false, nil)
		}
		proof, ok := iv.(map[string]any)
		if !ok || !verifyInclusion(rec, proof) {
			return fail(14, "inclusion proof does not place this record in the claimed log", false, nil)
		}
	}
	fmt.Printf("ok  countersign %s seq %d keyId %s\n", rec["id"], seq, keyID)
	return 0
}
