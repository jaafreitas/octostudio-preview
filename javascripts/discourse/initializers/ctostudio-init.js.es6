import { withPluginApi } from "discourse/lib/plugin-api";

// Feature Flag: Toggle to 'true' when the OctoStudio app is updated to support the intent/UTI
const ENABLE_WEB_SHARE_API = true; 

const HEADER_BEGINNING = 'OCTOSTUDIO';
const ZIP_START_BYTE = HEADER_BEGINNING.length;
const OCTOSTUDIO_MIME_TYPE = "application/x-octostudio";

function unpackProject(byteArray) {
  console.log("[OctoStudio Viewer] Unpacking project bytes...");
  const textDecoder = new TextDecoder();
  const beginning = textDecoder.decode(byteArray.subarray(0, HEADER_BEGINNING.length));

  if (beginning !== HEADER_BEGINNING) {
    console.error("[OctoStudio Viewer] Invalid signature. Expected 'OCTOSTUDIO', found:", beginning);
    throw new Error("OCTOSTUDIO signature not found.");
  }

  const zipStartPos = (
    byteArray[ZIP_START_BYTE] |
    (byteArray[ZIP_START_BYTE + 1] << 8) |
    (byteArray[ZIP_START_BYTE + 2] << 16) |
    (byteArray[ZIP_START_BYTE + 3] << 24)
  ) >>> 0;

  console.log(`[OctoStudio Viewer] ZIP start position detected at byte: ${zipStartPos}`);

  let zipEndPos = -1;
  // Searching for End of Central Directory (EOCD) signature
  for (let i = byteArray.length - 22; i >= zipStartPos; i--) {
    if (
      byteArray[i] === 0x50 &&
      byteArray[i + 1] === 0x4b &&
      byteArray[i + 2] === 0x05 &&
      byteArray[i + 3] === 0x06
    ) {
      const commentLength = byteArray[i + 20] | (byteArray[i + 21] << 8);
      zipEndPos = i + 22 + commentLength;
      console.log(`[OctoStudio Viewer] EOCD signature found. ZIP end position: ${zipEndPos}`);
      break;
    }
  }

  if (zipEndPos === -1) {
    console.error("[OctoStudio Viewer] EOCD signature missing. File might be truncated or corrupted.");
    throw new Error("EOCD signature not found.");
  }

  return byteArray.slice(zipStartPos, zipEndPos);
}

export default {
  name: "octostudio-viewer",
  initialize() {
    console.log("[OctoStudio Viewer] Version 20260322.0100");
    console.log(`[OctoStudio Viewer] Web Share API integration is currently: ${ENABLE_WEB_SHARE_API ? 'ENABLED' : 'DISABLED'}`);
    
    withPluginApi("0.8.31", (api) => {
      api.decorateCookedElement(
        async (element) => {
          const links = element.querySelectorAll('a.attachment[href*=".octostudio"]');
          if (!links.length) return;

          console.log(`[OctoStudio Viewer] Found ${links.length} .octostudio attachment(s) in the post.`);

          const JSZip = window.JSZip;
          if (!JSZip) {
            console.error("[OctoStudio Viewer] JSZip library is missing from the global window object. Aborting.");
            return;
          }

          links.forEach(async (link) => {
            if (link.dataset.octoProcessed) return;
            link.dataset.octoProcessed = "true";

            // 1. DOM HIJACKING: Prevent default routing and pre-fetch link data
            const originalUrl = link.href;
            link.dataset.targetUrl = originalUrl;
            link.href = "javascript:void(0);";
            console.log(`[OctoStudio Viewer] Link hijacked. Target URL stored: ${originalUrl}`);

            // 2. PREVIEW RENDER: Extract thumbnail silently in the background
            try {
              console.log(`[OctoStudio Viewer] Fetching file for preview extraction: ${originalUrl}`);
              const response = await fetch(originalUrl);
              
              if (!response.ok) {
                console.error(`[OctoStudio Viewer] Preview fetch failed. HTTP Status: ${response.status}`);
                throw new Error(`HTTP Error: ${response.status}`);
              }
              
              const arrayBuffer = await response.arrayBuffer();
              const byteArray = new Uint8Array(arrayBuffer);
              console.log(`[OctoStudio Viewer] Preview payload received. Size: ${byteArray.byteLength} bytes.`);

              const zipBuffer = unpackProject(byteArray);
              const zip = await JSZip.loadAsync(zipBuffer);
              console.log("[OctoStudio Viewer] JSZip loaded successfully.");

              const dataFile = zip.file("project/data.json");
              let thumbFileName = null;

              if (dataFile) {
                const jsonString = await dataFile.async("string");
                const projectData = JSON.parse(jsonString);
                thumbFileName = projectData.thumb || projectData.thumbnail;
                console.log("[OctoStudio Viewer] Project metadata parsed. Expected thumbnail:", thumbFileName);
              }

              let thumbFile = null;
              if (thumbFileName) {
                thumbFile = zip.file(`project/${thumbFileName}`) || zip.file(`project/thumbnails/${thumbFileName}`);
              }

              if (!thumbFile) {
                console.log("[OctoStudio Viewer] Exact thumbnail match not found. Attempting fallback extraction...");
                const autoThumbs = Object.keys(zip.files).filter(f => 
                  f.startsWith("project/thumbnails/") && !zip.files[f].dir
                );
                if (autoThumbs.length > 0) {
                  thumbFile = zip.file(autoThumbs[0]);
                  console.log(`[OctoStudio Viewer] Fallback thumbnail selected: ${autoThumbs[0]}`);
                }
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
                previewImg.alt = "OctoStudio Preview";
                
                previewImg.src = URL.createObjectURL(imgData);
                link.after(previewImg);
                console.log("[OctoStudio Viewer] Preview image injected into the DOM.");
              } else {
                console.warn("[OctoStudio Viewer] No suitable thumbnail found.");
              }
            } catch (e) {
              console.error("[OctoStudio Viewer] Preview rendering failed completely: ", e);
            }

            // 3. CLICK INTERCEPTION: File transfer logic
            link.addEventListener("click", async (event) => {
              console.log("[OctoStudio Viewer] Click event fired.");
              
              // Forcefully block all other event listeners (Discourse router, Safari native handlers)
              event.preventDefault();
              event.stopPropagation();
              event.stopImmediatePropagation();
              console.log("[OctoStudio Viewer] Event propagation halted.");

              const targetElement = event.target.closest('a');
              if (!targetElement) {
                console.warn("[OctoStudio Viewer] Click target is not an anchor element. Ignoring.");
                return;
              }
              
              if (targetElement.dataset.loading === "true") {
                console.warn("[OctoStudio Viewer] Click ignored. Download is already in progress.");
                return;
              }

              // UI State: Loading (Visual and Functional Lock)
              targetElement.dataset.loading = "true";
              targetElement.style.opacity = "0.5";
              targetElement.style.pointerEvents = "none";
              console.log("[OctoStudio Viewer] UI locked: opacity reduced and pointer-events disabled.");

              try {
                const targetUrl = targetElement.dataset.targetUrl;
                console.log(`[OctoStudio Viewer] Initiating download fetch for target URL: ${targetUrl}`);
                
                const downloadResponse = await fetch(targetUrl);
                
                // Logging HTTP Headers for deep debugging
                console.log("[OctoStudio Viewer] --- HTTP Headers ---");
                for (const [key, value] of downloadResponse.headers.entries()) {
                  console.log(`${key}: ${value}`);
                }
                console.log("[OctoStudio Viewer] --- End of HTTP Headers ---");

                if (!downloadResponse.ok) {
                  throw new Error(`Download HTTP Status: ${downloadResponse.status}`);
                }

                const buffer = await downloadResponse.arrayBuffer();
                console.log(`[OctoStudio Viewer] Download array buffer received. Size: ${buffer.byteLength} bytes.`);
                
                // Filename extraction
                const urlParts = targetUrl.split('/');
                let fileName = urlParts[urlParts.length - 1].split('?')[0];
                if (!fileName.endsWith('.octostudio')) {
                  fileName += '.octostudio';
                  console.log(`[OctoStudio Viewer] Enforced .octostudio extension. New filename: ${fileName}`);
                } else {
                  console.log(`[OctoStudio Viewer] Valid filename extracted: ${fileName}`);
                }

                let sharedNatively = false;

                // Attempt Web Share API if enabled and supported by the browser engine
                if (ENABLE_WEB_SHARE_API && navigator.canShare) {
                  console.log("[OctoStudio Viewer] Web Share API enabled. Evaluating file support...");
                  const shareFile = new File([buffer], fileName, { type: OCTOSTUDIO_MIME_TYPE });
                  const shareData = { files: [shareFile] };
                  
                  if (navigator.canShare(shareData)) {
                    console.log("[OctoStudio Viewer] File validation passed. Triggering await navigator.share().");
                    try {
                      // Execution will wait indefinitely until the user closes the menu or selects an app
                      await navigator.share(shareData);
                      sharedNatively = true;
                      console.log("[OctoStudio Viewer] Native Share Sheet successfully concluded.");
                    } catch (error) {
                      if (error.name === 'AbortError') {
                        console.log("[OctoStudio Viewer] Share Sheet actively aborted by user.");
                        return; // Interrupts the flow and proceeds to the finally block
                      } else {
                        // Catches NotAllowedError (loss of transient activation) or DataError
                        console.warn("[OctoStudio Viewer] Web Share API rejected. Triggering fallback logic.", error);
                      }
                    }
                  } else {
                    console.log("[OctoStudio Viewer] navigator.canShare(data) rejected the file object. Triggering fallback logic.");
                  }
                } else if (!ENABLE_WEB_SHARE_API) {
                  console.log("[OctoStudio Viewer] Web Share API disabled by feature flag. Proceeding to Blob download.");
                }

                // Fallback: Blob Creation & OS Download Trigger
                if (!sharedNatively) {
                  console.log(`[OctoStudio Viewer] Creating Blob with MIME type: ${OCTOSTUDIO_MIME_TYPE}`);
                  const blob = new Blob([buffer], { type: OCTOSTUDIO_MIME_TYPE });
                  const blobUrl = URL.createObjectURL(blob);

                  const tempLink = document.createElement("a");
                  tempLink.href = blobUrl;
                  tempLink.download = fileName;

                  console.log("[OctoStudio Viewer] Injecting temporary anchor to trigger OS download...");
                  document.body.appendChild(tempLink);
                  tempLink.click();
                  document.body.removeChild(tempLink);
                
                  setTimeout(() => {
                    URL.revokeObjectURL(blobUrl);
                    console.log("[OctoStudio Viewer] Blob URL revoked to free memory.");
                  }, 1000);
                }

              } catch (e) {
                console.error("[OctoStudio Viewer] Critical failure during file processing/download: ", e);
              } finally {
                // UI State: Restore (Visual and Functional Unlock)
                targetElement.dataset.loading = "false";
                targetElement.style.opacity = "1";
                targetElement.style.pointerEvents = "auto";
                console.log("[OctoStudio Viewer] Click processing completed. Link state restored.");
              }
            });
          });
        },
        { id: "octostudio-handler" }
      );
    });
  },
};
