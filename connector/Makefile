PREFIX     ?= $(HOME)/.local
BINDIR     ?= $(PREFIX)/bin
HOST_PATH  := $(BINDIR)/alexandria-connector
MANIFEST_DIR ?= $(HOME)/.mozilla/native-messaging-hosts
MANIFEST   := $(MANIFEST_DIR)/io.github.pemsley.alexandria.json
CONFIG_DIR := $(HOME)/.config/alexandria-connector

.PHONY: install uninstall

install:
	install -d $(BINDIR) $(MANIFEST_DIR) $(CONFIG_DIR)
	install -m 0755 alexandria_connector.py $(HOST_PATH)
	sed 's|@@HOST_PATH@@|$(HOST_PATH)|' io.github.pemsley.alexandria.json.in > $(MANIFEST)
	@echo
	@echo "Installed connector at: $(HOST_PATH)"
	@echo "Installed manifest at:  $(MANIFEST)"
	@echo
	@echo "Next: create $(CONFIG_DIR)/config.toml with a single line:"
	@echo "    library_dir = \"/path/to/your/papers\""

uninstall:
	rm -f $(HOST_PATH) $(MANIFEST)
	@echo "Removed connector and manifest. Config at $(CONFIG_DIR) left in place."
