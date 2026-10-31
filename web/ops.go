package main

// Edit operations on a roadmap document.
//
// A roadmap is one JSON document: lanes > subs > items, plus markers and a
// few top-level fields. Browsers never upload the whole document; they send
// small operations, the server applies them in the order they arrive and
// hands the same operations to everybody else. Conflicts resolve per field,
// last writer wins - two people changing different fields of the same task
// both keep their change.
//
//   {"t":"root","f":{"name":..,"view.theme":..}}           top-level fields
//   {"t":"set","id":X,"f":{"name":..,"progress":..}}       fields of one entity
//   {"t":"add","id":X,"kind":K,"parent":P,"after":S,"data":{..}}
//   {"t":"move","id":X,"parent":P,"after":S}
//   {"t":"del","id":X}                                      and everything under it
//
// kind is lane | sub | item | marker. parent is "" for lanes and markers.
// after is the sibling to go after, "" for first; a sibling that no longer
// exists means "at the end". Every operation is safe to apply twice and safe
// to apply to a document that has moved on: an operation whose target or
// parent has gone is skipped, never an error.
//
// ui/ops.js implements the same rules for the browser; testdata/ops/*.json
// holds cases both test suites must agree on.

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

type op struct {
	T      string         `json:"t"`
	ID     string         `json:"id,omitempty"`
	Kind   string         `json:"kind,omitempty"`
	Parent string         `json:"parent,omitempty"`
	After  string         `json:"after,omitempty"`
	F      map[string]any `json:"f,omitempty"`
	Data   map[string]any `json:"data,omitempty"`
}

const (
	maxOpsPerBatch = 20000
	maxIDLen       = 64
)

var (
	// Where each kind lives: the field of its parent that lists it.
	containerField = map[string]string{"lane": "lanes", "marker": "markers", "sub": "subs", "item": "items"}
	// What kind the parent must be ("" = the document itself).
	parentKind = map[string]string{"lane": "", "marker": "", "sub": "lane", "item": "sub"}
	// The list a kind owns, which operations may never overwrite directly.
	childField = map[string]string{"lane": "subs", "sub": "items"}
	// Fields no "set" may touch: identity and structure.
	protected = map[string]bool{"id": true, "lanes": true, "markers": true, "subs": true, "items": true}
	// Top-level fields a "root" operation may change.
	rootFields = map[string]bool{"name": true, "start": true, "end": true}
)

type entity struct {
	node   map[string]any
	kind   string
	parent string
}

type docIndex struct {
	root map[string]any
	ents map[string]*entity
}

func idOf(v any) string {
	if m, ok := v.(map[string]any); ok {
		if s, ok := m["id"].(string); ok {
			return s
		}
	}
	return ""
}

func list(holder map[string]any, field string) []any {
	if l, ok := holder[field].([]any); ok {
		return l
	}
	l := []any{}
	holder[field] = l
	return l
}

func indexDoc(doc map[string]any) *docIndex {
	d := &docIndex{root: doc, ents: map[string]*entity{}}
	for _, m := range list(doc, "markers") {
		if n, ok := m.(map[string]any); ok && idOf(n) != "" {
			d.ents[idOf(n)] = &entity{n, "marker", ""}
		}
	}
	for _, l := range list(doc, "lanes") {
		lane, ok := l.(map[string]any)
		if !ok || idOf(lane) == "" {
			continue
		}
		d.ents[idOf(lane)] = &entity{lane, "lane", ""}
		for _, s := range list(lane, "subs") {
			sub, ok := s.(map[string]any)
			if !ok || idOf(sub) == "" {
				continue
			}
			d.ents[idOf(sub)] = &entity{sub, "sub", idOf(lane)}
			for _, i := range list(sub, "items") {
				if item, ok := i.(map[string]any); ok && idOf(item) != "" {
					d.ents[idOf(item)] = &entity{item, "item", idOf(sub)}
				}
			}
		}
	}
	return d
}

// holder returns the map whose field lists entities of kind under parent.
func (d *docIndex) holder(kind, parent string) (map[string]any, bool) {
	want, ok := parentKind[kind]
	if !ok {
		return nil, false
	}
	if want == "" {
		return d.root, parent == ""
	}
	p, ok := d.ents[parent]
	if !ok || p.kind != want {
		return nil, false
	}
	return p.node, true
}

func insertAfter(l []any, node map[string]any, after string) []any {
	at := len(l)
	if after == "" {
		at = 0
	} else {
		for i, x := range l {
			if idOf(x) == after {
				at = i + 1
				break
			}
		}
	}
	l = append(l, nil)
	copy(l[at+1:], l[at:])
	l[at] = node
	return l
}

func (d *docIndex) detach(e *entity, id string) {
	h, ok := d.holder(e.kind, e.parent)
	if !ok {
		return
	}
	f := containerField[e.kind]
	l := list(h, f)
	for i, x := range l {
		if idOf(x) == id {
			h[f] = append(l[:i:i], l[i+1:]...)
			return
		}
	}
}

func (d *docIndex) forget(id string) {
	e := d.ents[id]
	if e == nil {
		return
	}
	delete(d.ents, id)
	if cf, ok := childField[e.kind]; ok {
		for _, c := range list(e.node, cf) {
			d.forget(idOf(c))
		}
	}
}

func (d *docIndex) apply(o op) {
	switch o.T {
	case "root":
		for k, v := range o.F {
			if rootFields[k] {
				d.root[k] = v
			} else if strings.HasPrefix(k, "view.") && len(k) > 5 {
				view, ok := d.root["view"].(map[string]any)
				if !ok {
					view = map[string]any{}
					d.root["view"] = view
				}
				view[k[5:]] = v
			}
		}
	case "set":
		e := d.ents[o.ID]
		if e == nil {
			return
		}
		for k, v := range o.F {
			if !protected[k] {
				e.node[k] = v
			}
		}
	case "add":
		if _, exists := d.ents[o.ID]; exists {
			return
		}
		h, ok := d.holder(o.Kind, o.Parent)
		if !ok {
			return
		}
		node := map[string]any{}
		for k, v := range o.Data {
			if !protected[k] {
				node[k] = v
			}
		}
		node["id"] = o.ID
		if cf, ok := childField[o.Kind]; ok {
			node[cf] = []any{}
		}
		f := containerField[o.Kind]
		h[f] = insertAfter(list(h, f), node, o.After)
		d.ents[o.ID] = &entity{node, o.Kind, o.Parent}
	case "move":
		e := d.ents[o.ID]
		if e == nil {
			return
		}
		h, ok := d.holder(e.kind, o.Parent)
		if !ok || o.After == o.ID {
			return
		}
		d.detach(e, o.ID)
		f := containerField[e.kind]
		h[f] = insertAfter(list(h, f), e.node, o.After)
		e.parent = o.Parent
	case "del":
		e := d.ents[o.ID]
		if e == nil {
			return
		}
		d.detach(e, o.ID)
		d.forget(o.ID)
	}
}

// validateOps rejects a batch that is malformed, as opposed to one that is
// merely stale (stale operations are skipped quietly by apply).
func validateOps(ops []op) error {
	if len(ops) == 0 {
		return errors.New("no operations")
	}
	if len(ops) > maxOpsPerBatch {
		return fmt.Errorf("%d operations in one batch; the limit is %d", len(ops), maxOpsPerBatch)
	}
	for i, o := range ops {
		switch o.T {
		case "root":
			if len(o.F) == 0 {
				return fmt.Errorf("operation %d: root without fields", i)
			}
		case "set", "del", "move", "add":
			if o.ID == "" || len(o.ID) > maxIDLen {
				return fmt.Errorf("operation %d: missing or overlong id", i)
			}
			if o.T == "add" {
				if _, ok := containerField[o.Kind]; !ok {
					return fmt.Errorf("operation %d: unknown kind %q", i, o.Kind)
				}
			}
			if o.T == "set" && len(o.F) == 0 {
				return fmt.Errorf("operation %d: set without fields", i)
			}
		default:
			return fmt.Errorf("operation %d: unknown type %q", i, o.T)
		}
		for k := range o.F {
			if len(k) > 80 {
				return fmt.Errorf("operation %d: field name too long", i)
			}
		}
	}
	return nil
}

// applyOps returns the document with ops applied. The input is not modified.
func applyOps(doc []byte, ops []op) ([]byte, error) {
	var m map[string]any
	dec := json.NewDecoder(strings.NewReader(string(doc)))
	dec.UseNumber()
	if err := dec.Decode(&m); err != nil {
		return nil, fmt.Errorf("stored roadmap is not valid JSON: %w", err)
	}
	d := indexDoc(m)
	for _, o := range ops {
		d.apply(o)
	}
	return json.Marshal(m)
}

// docSummary extracts what the roadmap list and versions need.
func docSummary(doc []byte) (name string, items int) {
	var m struct {
		Name  string `json:"name"`
		Lanes []struct {
			Subs []struct {
				Items []json.RawMessage `json:"items"`
			} `json:"subs"`
		} `json:"lanes"`
	}
	json.Unmarshal(doc, &m)
	for _, l := range m.Lanes {
		for _, s := range l.Subs {
			items += len(s.Items)
		}
	}
	return m.Name, items
}
