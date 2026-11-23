package settings

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPrintSettingsMigrateWithDefaults(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "settings.json"), []byte(`{"theme":"dark"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	s, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	got := s.Get()
	if !got.PrintIncludeAnnotations || got.PrintRangeMode != "all" || got.PrintOnlyAnnotated || !got.PrintConfigured {
		t.Fatalf("migration = %+v", got)
	}
}

func TestPrintSettingsPersistExplicitFalse(t *testing.T) {
	dir := t.TempDir()
	s, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	v := s.Get()
	v.PrintIncludeAnnotations = false
	v.PrintRangeMode = "custom"
	v.PrintOnlyAnnotated = true
	v.PrintConfigured = true
	if err := s.Set(v); err != nil {
		t.Fatal(err)
	}

	s2, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	got := s2.Get()
	if got.PrintIncludeAnnotations || got.PrintRangeMode != "custom" || !got.PrintOnlyAnnotated {
		t.Fatalf("round trip = %+v", got)
	}
}

func TestPrintRangeModeNormalized(t *testing.T) {
	v := normalize(Settings{PrintConfigured: true, PrintRangeMode: "bogus"})
	if v.PrintRangeMode != "all" {
		t.Fatalf("range = %q", v.PrintRangeMode)
	}
}
