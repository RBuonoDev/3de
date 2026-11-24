# 3DE

Aplicação web de modelagem CAD para criar, visualizar e analisar peças mecânicas no navegador, em milímetros. Inclui um leitor assistido de desenhos técnicos (imagem → peça 3D paramétrica).

## Funcionalidades

- Editor 3D próprio: árvore de recursos, esboços, ressalto/corte extrudado e revolucionado, filete, chanfro, casca, padrões, espelho, edição paramétrica, desfazer/refazer.
- Medição, propriedades de massa e vista de seção.
- Abrir/salvar projetos `.3de`, importar e exportar STL.
- Digitalizador 3D: leitura de desenhos técnicos (PNG, JPG, WEBP), inclusive pranchas com duas ou três vistas, com OCR das cotas e envio ao editor como projeto editável.
- Projetos salvos e peças geradas guardados em PostgreSQL (Supabase).

## Organização do código

- `app.py`: servidor Flask e rotas.
- `storage.py`: banco de dados (PostgreSQL via `DATABASE_URL`, ou memória sem ela).
- `cad_kernel.py`: núcleo geométrico (esboços, extrusões, revoluções e booleanas) usado pelo servidor.
- `static/editor/`: editor 3D (`editor.js`, `kernel.js`, `gfx.js`, `editor.css`, `index.html`).
- `drawing_reader.html`: Digitalizador 3D.
- `sheet_cleanup.py`, `drawing_model.py`, `parametric_model.py`, `*_reader.py`, `dimension_ocr.py`: reconhecimento das peças e das cotas.

## Executar no computador

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

Abra `http://localhost:5000`.

## Hospedagem (Render + Supabase)

O `render.yaml` configura o serviço no Render (New → Blueprint). Na criação, informe em
`DATABASE_URL` a connection string do Supabase (Session pooler, porta 5432). As tabelas são
criadas automaticamente na primeira execução.
