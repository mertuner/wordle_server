const wordList = require('./wordle-list.json');

function getRandomWord() {
    const words = wordList.words;
    return words[Math.floor(Math.random() * words.length)].toUpperCase();
}

function isValidWord(word) {
    return wordList.words.includes(word.toLowerCase());
}

module.exports = { 
    getRandomWord,
    isValidWord,
    wordList: wordList.words 
}; 