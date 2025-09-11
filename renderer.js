// import { parsed } from "./startup.mjs";
// import { readFile } from 'node:fs/promises'

// const filePathJS = 'versions.json';

// async function readJsonFile() {
//   try {
//     const fileContent = await readFile(filePathJS, { encoding: 'utf8' });
//     const jsonData = JSON.parse(fileContent);
//     console.log(jsonData)
//     return jsonData

//   } catch (error) {
//     if (error.code === 'ENOENT') {
//       console.error(`Ошибка: Файл '${filePathJS}' не найден.`);
//     } else if (error instanceof SyntaxError) {
//       console.error(`Ошибка парсинга JSON в файле '${filePathJS}':`, error.message);
//     } else {
//       console.error('Произошла непредвиденная ошибка при чтении файла:', error);
//     }
//   }
// }

// readJsonFile();

window.addEventListener('DOMContentLoaded', async () => {
    try {
      const data = await window.api.getStartupData();
    //   console.log(data, JSON.stringify(data), data.Barotrauma, JSON.stringify(data).Barotrauma)
      document.getElementById('version-b').innerHTML = `Версия игры: ${data.Barotrauma}`;
    } catch (err) {
      console.error(err);
    }
  });