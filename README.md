# Study Spark ♡

Cute, mobile-first homework helper with DeepSeek vision support.

## Live site
This repository is configured to deploy the front end with GitHub Pages.

## Included
- Multiple image upload, up to 10 photos per request
- Solve mode
- Just Answer mode
- Teach Me mode
- Check Work mode
- Interactive Quiz Me mode
- Organized answer cards
- Mobile-friendly thumbnail strip with per-image removal
- Server-side API key handling

## Run locally
1. Install Node.js 18+.
2. Open this folder in a terminal.
3. Run `npm install`.
4. Copy `.env.example` to `.env`.
5. Put your DeepSeek API key in `.env`.
6. Run `npm start`.
7. Open `http://localhost:3000`.

## Model
Change `DEEPSEEK_MODEL` in `.env` whenever you want to switch to a newer compatible DeepSeek vision model.

## Security
Never put your API key in `index.html` or commit your `.env` file to a public repository.
