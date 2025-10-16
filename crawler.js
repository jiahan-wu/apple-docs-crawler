#!/usr/bin/env node

const readline = require('readline');
const https = require('https');
const puppeteer = require('puppeteer');
const { Readability } = require('@mozilla/readability');
const TurndownService = require('turndown');
const { JSDOM } = require('jsdom');
const fs = require('fs-extra');
const path = require('path');

// Create readline interface
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Prompt user to input topic name
rl.question('Please enter the topic name to crawl: ', async (topicName) => {
  console.log(`Starting crawl for topic: ${topicName}`);
  
  const url = `https://developer.apple.com/tutorials/data/index/${topicName}`;
  
  try {
    const response = await makeHttpRequest(url);
    if (response.interfaceLanguages && 
        response.interfaceLanguages.swift && 
        response.interfaceLanguages.swift.length > 0 && 
        response.interfaceLanguages.swift[0].children) {
      
      const children = response.interfaceLanguages.swift[0].children;
      
      console.log(`Found ${children.length} items (${children.filter(item => item.path).length} with valid paths)`);
      
      // Collect all valid URLs
      const validUrls = [];
      children.forEach((item, index) => {
        if (item.path) {
          const fullUrl = `https://developer.apple.com${item.path}`;
          validUrls.push({
            index: index,
            title: item.title || 'untitled',
            type: item.type || 'unknown',
            path: item.path,
            url: fullUrl
          });
        }
      });
      
      console.log(`Starting crawl of ${validUrls.length} pages...`);
      await crawlPages(validUrls, topicName);
      
    } else {
      console.error('Cannot find specified path: interfaceLanguages.swift[0].children');
      console.error('Available top-level properties:', Object.keys(response));
    }
    
  } catch (error) {
    console.error('Request failed:', error.message);
  }
  
  // Close readline interface
  rl.close();
});

// HTTP request function
function makeHttpRequest(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const jsonResponse = JSON.parse(data);
          resolve(jsonResponse);
        } catch (error) {
          reject(new Error('Response is not valid JSON format'));
        }
      });
      
    }).on('error', (error) => {
      reject(error);
    });
  });
}

// Clean filename, remove illegal characters
function sanitizeFilename(filename) {
  return filename
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, '_')
    .replace(/[^\w\-_.]/g, '')
    .substring(0, 100); // Limit filename length
}

// Find related links from the same framework in a page
function findRelatedLinks(dom, currentFramework) {
  const links = [];
  const linkElements = dom.window.document.querySelectorAll('a[href]');
  
  linkElements.forEach(link => {
    const href = link.getAttribute('href');
    const text = link.textContent.trim();
    
    // Check if it's an Apple Developer documentation link
    if (href && href.includes('/documentation/')) {
      let fullUrl = href;
      if (href.startsWith('/')) {
        fullUrl = `https://developer.apple.com${href}`;
      }
      
      // Check if it belongs to the same framework
      if (fullUrl.includes(`/documentation/${currentFramework}/`) || 
          fullUrl.includes(`/documentation/${currentFramework.toLowerCase()}/`)) {
        links.push({
          url: fullUrl,
          title: text || 'Untitled',
          type: 'related'
        });
      }
    }
  });
  
  return links;
}

// Use Puppeteer to crawl single page
async function crawlSinglePage(browser, pageInfo, crawledUrls, pendingUrls, currentFramework) {
  const page = await browser.newPage();
  
  try {
    // Set user agent
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
    
    // Navigate to page
    await page.goto(pageInfo.url, { 
      waitUntil: 'networkidle0',
      timeout: 30000
    });
    
    // Wait for page content to fully load
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Get page HTML
    const html = await page.content();
    
    // Find related links (before content extraction, using full DOM)
    const fullDom = new JSDOM(html, { url: pageInfo.url });
    const relatedLinks = findRelatedLinks(fullDom, currentFramework);
    
    // Add newly discovered links to pending queue
    let newLinksCount = 0;
    relatedLinks.forEach(link => {
      if (!crawledUrls.has(link.url) && !pendingUrls.has(link.url)) {
        pendingUrls.set(link.url, {
          url: link.url,
          title: link.title,
          type: link.type,
          index: crawledUrls.size + pendingUrls.size
        });
        newLinksCount++;
      }
    });
    

    
    // Use Readability to extract main content
    const dom = new JSDOM(html, { url: pageInfo.url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    
    if (article) {
      // Convert to Markdown
      const turndownService = new TurndownService({
        headingStyle: 'atx',
        codeBlockStyle: 'fenced'
      });
      
      const markdown = turndownService.turndown(article.content);
      
      // Extract page title from <title> tag
      const titleElement = dom.window.document.querySelector('title');
      const pageTitle = titleElement ? titleElement.textContent.trim() : (article.title || pageInfo.title);
      
      // Generate filename using page title
      const filename = `${pageInfo.index.toString().padStart(3, '0')}_${sanitizeFilename(pageTitle)}.md`;
      
      return {
        filename: filename,
        content: `# ${pageTitle}\n\n${markdown}`,
        success: true,
        newLinksFound: newLinksCount
      };
    } else {
      console.warn(`⚠️  Unable to extract content: ${pageInfo.title}`);
      return { success: false, error: 'Unable to extract content', newLinksFound: newLinksCount };
    }
    
  } catch (error) {
    console.error(`❌ Crawl failed [${pageInfo.index}]: ${pageInfo.title} - ${error.message}`);
    return { success: false, error: error.message, newLinksFound: 0 };
  } finally {
    await page.close();
  }
}

// Crawl all pages with dynamic discovery
async function crawlPages(urls, topicName) {
  console.log('Launching Puppeteer...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  try {
    // Create output directory
    const outputDir = path.join(process.cwd(), 'docs', topicName);
    await fs.ensureDir(outputDir);
    console.log(`Output directory: ${outputDir}`);
    
    // Initialize tracking sets
    const crawledUrls = new Set();  // URLs that have been successfully crawled
    const pendingUrls = new Map();  // URLs waiting to be crawled
    
    // Add initial URLs to pending queue
    urls.forEach(pageInfo => {
      pendingUrls.set(pageInfo.url, pageInfo);
    });
    
    let successCount = 0;
    let errorCount = 0;
    let totalNewLinksFound = 0;
    
    // Extract framework name from topic for related link detection
    const currentFramework = topicName.toLowerCase();
    
    // Limit concurrent requests to avoid overload
    const concurrentLimit = 50;
    
    console.log(`Starting crawl with ${pendingUrls.size} URLs in queue\n`);
    
    while (pendingUrls.size > 0) {
      // Get next batch of URLs to process
      const currentBatch = Array.from(pendingUrls.values()).slice(0, concurrentLimit);
      
      // Remove these URLs from pending queue
      currentBatch.forEach(pageInfo => {
        pendingUrls.delete(pageInfo.url);
        crawledUrls.add(pageInfo.url);
      });
      
      // Process current batch
      const promises = currentBatch.map(pageInfo => 
        crawlSinglePage(browser, pageInfo, crawledUrls, pendingUrls, currentFramework)
      );
      
      const results = await Promise.all(promises);
      
      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        const pageInfo = currentBatch[j];
        
        if (result.success) {
          // Write file
          const filePath = path.join(outputDir, result.filename);
          fs.writeFile(filePath, result.content, 'utf8');
          successCount++;
          totalNewLinksFound += result.newLinksFound || 0;
        } else {
          console.error(`❌ Failed: ${pageInfo.title} - ${result.error}`);
          errorCount++;
          if (result.newLinksFound) {
            totalNewLinksFound += result.newLinksFound;
          }
        }
      }
      
      // Show progress and wait between batches
      if (pendingUrls.size > 0) {
        console.log(`Progress: ${successCount + errorCount} completed, ${pendingUrls.size} remaining\n`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    
    console.log(`\n🎉 Crawl completed!`);
    console.log(`✅ Success: ${successCount}`);
    console.log(`❌ Failed: ${errorCount}`);
    console.log(`🔗 New links discovered: ${totalNewLinksFound}`);
    console.log(`📄 Total pages processed: ${successCount + errorCount}`);
    
  } finally {
    await browser.close();
  }
}