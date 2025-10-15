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
      
      children.forEach((item, index) => {
        if (item.path) {
          const fullUrl = `https://developer.apple.com${item.path}`;
          console.log(`[${index}] ${item.title || 'untitled'}`);
        } else {
          console.log(`[${index}] No path property - ${item.title || 'N/A'}`);
        }
      });
      
      console.log(`Found ${children.length} items (${children.filter(item => item.path).length} with paths)`);
      
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
      console.log('Cannot find specified path: interfaceLanguages.swift[0].children');
      console.log('Available top-level properties:', Object.keys(response));
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

// Use Puppeteer to crawl single page
async function crawlSinglePage(browser, pageInfo) {
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
      
      // Generate filename
      const filename = `${pageInfo.index.toString().padStart(3, '0')}_${sanitizeFilename(pageInfo.title)}.md`;
      
      return {
        filename: filename,
        content: `# ${article.title || pageInfo.title}\n\n${markdown}`,
        success: true
      };
    } else {
      console.log(`⚠️  Cannot extract content: ${pageInfo.title}`);
      return { success: false, error: 'Cannot extract content' };
    }
    
  } catch (error) {
    console.error(`❌ Failed [${pageInfo.index}]: ${pageInfo.title} - ${error.message}`);
    return { success: false, error: error.message };
  } finally {
    await page.close();
  }
}

// Crawl all pages
async function crawlPages(urls, topicName) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  try {
    // Create output directory
    const outputDir = path.join(process.cwd(), 'docs', topicName);
    await fs.ensureDir(outputDir);
    console.log(`Output directory: ${outputDir}`);
    
    let successCount = 0;
    let errorCount = 0;
    
    // Limit concurrent requests to avoid overload
    const concurrentLimit = 3;
    
    for (let i = 0; i < urls.length; i += concurrentLimit) {
      const batch = urls.slice(i, i + concurrentLimit);
      const promises = batch.map(pageInfo => crawlSinglePage(browser, pageInfo));
      
      const results = await Promise.all(promises);
      
      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        const pageInfo = batch[j];
        
        if (result.success) {
          // Write file
          const filePath = path.join(outputDir, result.filename);
          await fs.writeFile(filePath, result.content, 'utf8');
          console.log(`✅ ${result.filename}`);
          successCount++;
        } else {
          console.log(`❌ ${pageInfo.title} - ${result.error}`);
          errorCount++;
        }
      }
      
      // Delay between batches
      if (i + concurrentLimit < urls.length) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    
    console.log(`\nCompleted: ${successCount} success, ${errorCount} failed (${urls.length} total)`);
    
  } finally {
    await browser.close();
  }
}