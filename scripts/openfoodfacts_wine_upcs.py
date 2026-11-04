import pandas as pd
import requests
import gzip
import os

def download_and_extract_wine_upcs(output_filename="wine_barcodes_extracted.xlsx"):
    # Official URL for Open Food Facts global tab-separated datasets
    data_url = "https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz"
    local_gz = "openfoodfacts_products.csv.gz"

    print("Step 1: Downloading the Open Food Facts global database...")
    print("Note: This file is massive. Streaming chunk-by-chunk to save disk and memory...")

    with requests.get(data_url, stream=True) as r:
        r.raise_for_status()
        with open(local_gz, 'wb') as f:
            for chunk in r.iter_content(chunk_size=16384):
                f.write(chunk)

    print("Download complete.")
    print("Step 2: Processing file in safe stream chunks to isolate wine items...")

    wine_records = []
    chunk_idx = 0

    with gzip.open(local_gz, 'rt', encoding='utf-8', errors='ignore') as f:
        # Open Food Facts is a tab-separated data archive (\t)
        for chunk in pd.read_csv(f, sep='\t', chunksize=50000, low_memory=False):
            chunk_idx += 1
            if 'categories_tags' in chunk.columns:
                # Isolate lines flagged under wine categories across English, French, and German tags
                is_wine = chunk['categories_tags'].astype(str).str.contains('wine|vin|wein', case=False, na=False)
                wine_chunk = chunk[is_wine]

                if not wine_chunk.empty:
                    cols_to_keep = [c for c in ['code', 'product_name', 'brands', 'categories', 'countries'] if c in chunk.columns]
                    wine_records.append(wine_chunk[cols_to_keep])

            if chunk_idx % 20 == 0:
                print(f"Read through {chunk_idx * 50000} items...")

    if wine_records:
        print("Step 3: Organizing data into an Excel spreadsheet...")
        final_df = pd.concat(wine_records, ignore_index=True)
        final_df.rename(columns={'code': 'UPC_EAN_Barcode'}, inplace=True)
        final_df.dropna(subset=['UPC_EAN_Barcode'], inplace=True)

        final_df.to_excel(output_filename, index=False, sheet_name="Extracted Wine Barcodes")
        print(f"Complete! Created '{output_filename}' containing {len(final_df)} filtered rows.")
    else:
        print("No matching wine products found in this archive partition.")

    if os.path.exists(local_gz):
        os.remove(local_gz)

if __name__ == '__main__':
    download_and_extract_wine_upcs()
