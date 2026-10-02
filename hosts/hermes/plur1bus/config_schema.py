"""No settings panel: the installer (or ``hermes plur1bus bind``) writes ``$HERMES_HOME/plur1bus.json``.

Hermes loads this file by path for its desktop panel and reads ``CONFIG_SCHEMA``; ``None`` means "no
panel" (``plugins/memory/config_schema.py`` ``get_provider_config_schema`` @ ``743ee72``). The provider's
``get_config_schema()`` is ``[]``, so ``hermes memory status`` shows "no setup needed".
"""

CONFIG_SCHEMA = None
