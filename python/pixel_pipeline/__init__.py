"""Processamento raster local do Pixel Studio.

Um subprocesso por tarefa: JSON do pedido no stdin, JSON da resposta no stdout,
diagnóstico no stderr. Arquivos só dentro da pasta de trabalho da tentativa
(diretório corrente). Node é dono do SQLite, dos blobs e da publicação.
"""

PROTOCOL_VERSION = 1
__version__ = "0.1.0"
