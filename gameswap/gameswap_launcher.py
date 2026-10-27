"""Entry point for the packaged GameSwap.exe (see GameSwap.spec)."""

import sys

from gameswap.__main__ import main

if __name__ == "__main__":
    sys.exit(main())
