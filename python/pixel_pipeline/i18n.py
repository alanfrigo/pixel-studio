"""Textos bilíngues do pipeline (avisos e rótulos que a interface mostra).

`tx("contorno cortado", "outline clipped")` devolve `{"pt-BR": ..., "en": ...}`;
o protocolo aceita esse objeto ou uma string simples (legado). A interface
escolhe o idioma do usuário; nada aqui depende de locale do sistema.
"""

from __future__ import annotations


def tx(pt_br: str, en: str) -> dict[str, str]:
    return {"pt-BR": pt_br, "en": en}
