package tree_sitter_kernellog_test

import (
	"testing"

	tree_sitter "github.com/tree-sitter/go-tree-sitter"
	tree_sitter_kernellog "github.com/tree-sitter/tree-sitter-kernellog/bindings/go"
)

func TestCanLoadGrammar(t *testing.T) {
	language := tree_sitter.NewLanguage(tree_sitter_kernellog.Language())
	if language == nil {
		t.Errorf("Error loading parse android kernel log and transform grammar")
	}
}
