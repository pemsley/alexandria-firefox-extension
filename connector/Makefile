PREFIX     ?= $(HOME)/.local
BINDIR     ?= $(PREFIX)/bin
HOST_PATH  := $(BINDIR)/alexandria-connector
MANIFEST_DIR ?= $(HOME)/.mozilla/native-messaging-hosts
MANIFEST   := $(MANIFEST_DIR)/io.github.pemsley.alexandria.json
CONFIG_DIR := $(HOME)/.config/alexandria-connector

VERSION    := 0.1.0
DIST_NAME  := alexandria-connector-$(VERSION)
DIST_DIR   := $(CURDIR)/../build/$(DIST_NAME)
DIST_TAR   := $(CURDIR)/../build/$(DIST_NAME).tar.gz

DIST_FILES := alexandria_connector.py \
              io.github.pemsley.alexandria.json.in \
              install.sh \
              uninstall.sh

.PHONY: install uninstall dist clean-dist

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

dist: $(DIST_TAR)
	@echo
	@echo "Built: $(DIST_TAR)"
	@echo
	@echo "Hand this to a colleague along with INSTALL.md. They can:"
	@echo "  tar xzf $(DIST_NAME).tar.gz"
	@echo "  cd $(DIST_NAME)"
	@echo "  ./install.sh"

$(DIST_TAR): $(DIST_FILES)
	rm -rf $(DIST_DIR)
	mkdir -p $(DIST_DIR)
	cp $(DIST_FILES) $(DIST_DIR)/
	chmod +x $(DIST_DIR)/install.sh $(DIST_DIR)/uninstall.sh $(DIST_DIR)/alexandria_connector.py
	tar czf $@ -C $(dir $(DIST_DIR)) $(DIST_NAME)

clean-dist:
	rm -rf $(CURDIR)/../build
