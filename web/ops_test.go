package main

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

type opsCase struct {
	Name   string  `json:"name"`
	Ops    []op    `json:"ops"`
	Shape  string  `json:"shape"`
	Checks [][]any `json:"checks"`
}

func shapeOf(doc map[string]any) string {
	var lanes []string
	for _, l := range list(doc, "lanes") {
		lane := l.(map[string]any)
		var subs []string
		for _, s := range list(lane, "subs") {
			sub := s.(map[string]any)
			var items []string
			for _, i := range list(sub, "items") {
				items = append(items, idOf(i))
			}
			subs = append(subs, idOf(sub)+"("+strings.Join(items, ",")+")")
		}
		lanes = append(lanes, idOf(lane)+"["+strings.Join(subs, ",")+"]")
	}
	var marks []string
	for _, m := range list(doc, "markers") {
		marks = append(marks, idOf(m))
	}
	return strings.Join(lanes, ",") + "|" + strings.Join(marks, ",")
}

// The same cases run in the browser's test (test/ops.test.js): the two
// implementations must never disagree, or two people would see different
// roadmaps after the same edits.
func TestOpsCasesSharedWithBrowser(t *testing.T) {
	raw, err := os.ReadFile("testdata/ops/cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Doc   json.RawMessage `json:"doc"`
		Cases []opsCase       `json:"cases"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatal(err)
	}
	if len(file.Cases) < 15 {
		t.Fatalf("only %d cases loaded", len(file.Cases))
	}
	for _, c := range file.Cases {
		t.Run(c.Name, func(t *testing.T) {
			if err := validateOps(c.Ops); err != nil {
				t.Fatalf("valid case rejected: %v", err)
			}
			out, err := applyOps(file.Doc, c.Ops)
			if err != nil {
				t.Fatal(err)
			}
			var doc map[string]any
			json.Unmarshal(out, &doc)
			if got := shapeOf(doc); got != c.Shape {
				t.Fatalf("shape\n got %s\nwant %s", got, c.Shape)
			}
			d := indexDoc(doc)
			for _, chk := range c.Checks {
				id, field, want := chk[0].(string), chk[1].(string), chk[2]
				var node map[string]any
				if id == "" {
					node = doc
				} else if e := d.ents[id]; e != nil {
					node = e.node
				}
				if field == "" {
					if (node != nil) != (want != nil) {
						t.Fatalf("%s: exists=%v, want exists=%v", id, node != nil, want != nil)
					}
					continue
				}
				if node == nil {
					t.Fatalf("%s: missing", id)
				}
				var got any
				if strings.HasPrefix(field, "view.") {
					got = node["view"].(map[string]any)[field[5:]]
				} else {
					got = node[field]
				}
				gj, _ := json.Marshal(got)
				wj, _ := json.Marshal(want)
				if string(gj) != string(wj) {
					t.Fatalf("%s.%s = %s, want %s", id, field, gj, wj)
				}
			}
		})
	}
}

func TestOpsRejectMalformedBatches(t *testing.T) {
	bad := [][]op{
		nil,
		{{T: "explode", ID: "x"}},
		{{T: "set", ID: "", F: map[string]any{"a": 1}}},
		{{T: "set", ID: "x"}},
		{{T: "add", ID: "x", Kind: "planet"}},
		{{T: "root"}},
		{{T: "del", ID: strings.Repeat("x", 65)}},
	}
	for i, b := range bad {
		if validateOps(b) == nil {
			t.Errorf("batch %d accepted: %+v", i, b)
		}
	}
	big := make([]op, maxOpsPerBatch+1)
	for i := range big {
		big[i] = op{T: "del", ID: "x"}
	}
	if validateOps(big) == nil {
		t.Error("oversized batch accepted")
	}
}

func TestOpsKeepNumbersExact(t *testing.T) {
	out, err := applyOps([]byte(`{"lanes":[],"markers":[],"big":12345678901234567890,"view":{}}`),
		[]op{{T: "root", F: map[string]any{"name": "x"}}})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(out), "12345678901234567890") {
		t.Fatalf("number rewritten: %s", out)
	}
}
