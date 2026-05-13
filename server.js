const express = require("express");
const path = require("path");

const app = express();

/* Allow form data */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* Serve public folder */
app.use(express.static("public"));

/* Home route */
app.get("/", (req, res) => {
res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* Start server */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
console.log("Server running on port " + PORT);
});
