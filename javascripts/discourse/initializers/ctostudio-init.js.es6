import { withPluginApi } from "discourse/lib/plugin-api";

const HEADER_BEGINNING = 'OCTOSTUDIO';
const ZIP_START_BYTE = HEADER_BEGINNING.length;

function unpackProject(byteArray) {
  const textDecoder = new TextDecoder();
  const beginning = textDecoder.decode(byteArray.subarray(0, HEADER_BEGINNING.length));

  if (beginning !== HEADER_BEGINNING) {
    throw new Error("Signature OCTOSTUDIO not found.");
  }

  const zipStartPos = (
    byteArray[ZIP_START_BYTE] |
    (byteArray[ZIP_START_BYTE + 1] << 8) |
    (byteArray[ZIP_START_BYTE + 2] << 16) |
    (byteArray[ZIP_START_BYTE + 3] << 24)
  ) >>> 0;

  let zipEndPos = -1;
  for (let i = byteArray.length - 22; i >= zipStartPos; i--) {
    if (
      byteArray[i] === 0x50 &&
      byteArray[i + 1] === 0x4b &&
      byteArray[i + 2] === 0x05 &&
      byteArray[i + 3] === 0x06
    ) {
      const commentLength = byteArray[i + 20] | (byteArray[i + 21] << 8);
      zipEndPos = i + 22 + commentLength;
      break;
    }
  }

  if (zipEndPos === -1) {
    throw new Error("EOCD signature not found. File might be truncated.");
  }

  return byteArray.slice(zipStartPos, zipEndPos);
}

export default {
  name: "octostudio-preview-init",
  initialize() {
    withPluginApi("0.8.31", (api) => {
      api.decorateCookedElement(
        async (element) => {
          const links = element.querySelectorAll('a.attachment[href*=".octostudio"]');
          if (!links.length) return;

          // JSZip is loaded via script tag in header.html
          const JSZip = window.JSZip;
          if (!JSZip) {
            console.error("[OctoStudio Viewer] JSZip library not found.");
            return;
          }

          links.forEach(async (link) => {
            if (link.dataset.octoProcessed) return;
            link.dataset.octoProcessed = "true";

            try {
              const response = await fetch(link.href);
              if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);
              
              const arrayBuffer = await response.arrayBuffer();
              const byteArray = new Uint8Array(arrayBuffer);

              const zipBuffer = unpackProject(byteArray);
              const zip = await JSZip.loadAsync(zipBuffer);

              // Extract metadata
              const dataFile = zip.file("project/data.json");
              let thumbFileName = null;

              if (dataFile) {
                const jsonString = await dataFile.async("string");
                const projectData = JSON.parse(jsonString);
                
                console.log("[OctoStudio Viewer] Project Metadata:", {
                  name: projectData.name,
                  title: projectData.title,
                  notes: projectData.notes
                });

                thumbFileName = projectData.thumb || projectData.thumbnail;
              }

              // Locate thumbnail
              let thumbFile = null;
              if (thumbFileName) {
                thumbFile = zip.file(`project/${thumbFileName}`) || zip.file(`project/thumbnails/${thumbFileName}`);
              }

              if (!thumbFile) {
                const possibleThumbs = Object.keys(zip.files).filter(name => 
                  name.startsWith("project/thumbnails/") && !zip.files[name].dir
                );
                if (possibleThumbs.length > 0) thumbFile = zip.file(possibleThumbs[0]);
              }

              if (thumbFile) {
                const imgData = await thumbFile.async("blob");
                const previewImg = document.createElement("img");
                
                previewImg.className = "octostudio-thumbnail-preview";
                previewImg.style.display = "block";
                previewImg.style.maxWidth = "400px";
                previewImg.style.marginTop = "10px";
                previewImg.style.borderRadius = "8px";
                previewImg.style.border = "1px solid var(--primary-low-mid)";
                
                previewImg.src = URL.createObjectURL(imgData);
                link.after(previewImg);
              }
            } catch (e) {
              console.error("[OctoStudio Viewer] Processing failed:", e.message);
            }
          });
        },
        { id: "octostudio-handler" }
      );
    });
  },
};
